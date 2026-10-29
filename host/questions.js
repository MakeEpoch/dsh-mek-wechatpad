/** Bridge DSH's question waterfall to the originating WeChat conversation. */
import { permissionReason } from './permission-text.js';
export class QuestionRelay {
  #ctx;
  #send;
  #logger;
  #prompts = new Map();
  #pending = new Set();
  #dispose;
  #disposeApproval;

  constructor({ ctx, send, logger = () => {} }) {
    this.#ctx = ctx;
    this.#send = send;
    this.#logger = logger;
    this.#dispose = ctx.on('user-questions/request', (request, next) => this.#ask(request, next), {
      global: true, prepend: true,
    });
    this.#disposeApproval = ctx.on('approval/request', (request, next) => this.#approve(request, next), {
      global: true, prepend: true,
    });
  }

  async #approve(request, next) {
    if (!this.#owner(request?.agent?.session)) return next();
    const session = request.agent.session;
    const events = session.snapshotEvents?.() ?? session.events ?? [];
    let call;
    for (const entry of [...events].reverse()) {
      const event = entry?.event ?? entry;
      if (event.type === 'turn/start') break;
      if ((event.type === 'tool/call' && event.data?.callId === request.callId)
        || (event.type === 'tool/code-dispatch-start' && event.data?.subCallId === request.callId)) {
        if (event.data.name === request.toolName) call = event.data;
        break;
      }
    }
    const signal = request.signal;
    const forwarded = { ...request, approval: true, permissionRequest: request, questions: [{
      id: 'approval', header: '等待审批',
      question: request.reason || `工具 ${request.toolName} 请求权限`,
      detail: `工具：${request.toolName}\n${call ? (typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)) : '未提供工具参数，请在网页核对操作详情。'}`,
      options: [{ label: '拒绝' }, { label: '允许一次' }],
    }] };
    try {
      const result = await this.#ask(forwarded, async () => {
        request.signal = forwarded.signal;
        const outcome = await next();
        if (!['allowed-once', 'rejected'].includes(outcome)) throw questionError('审批端不可用', 'NO_PROVIDER');
        return { answers: [{ selected: [outcome === 'allowed-once' ? '允许一次' : '拒绝'] }] };
      });
      return result.answers[0].selected[0] === '允许一次' ? 'allowed-once' : 'rejected';
    } catch (error) {
      return error.code === 'ASK_ABORTED' || error.code === 'ASK_CANCELLED' ? 'cancelled' : 'unavailable';
    } finally {
      request.signal = signal;
    }
  }

  trackPrompt({ requestId, sessionId, chatId, senderId }) {
    this.#prompts.set(requestId, { sessionId, chatId, senderId });
    // Bound historical ownership; only the current turn's source can claim a question.
    if (this.#prompts.size > 1000) this.#prompts.delete(this.#prompts.keys().next().value);
  }

  forgetPrompt(requestId) {
    this.#prompts.delete(requestId);
  }

  #owner(session) {
    const events = session?.snapshotEvents?.() ?? session?.events;
    if (!Array.isArray(events)) return null;
    let owner = null;
    for (const entry of events) {
      const event = entry?.event ?? entry;
      if (event?.type === 'turn/start' || event?.type === 'turn/end') owner = null;
      if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
        owner = this.#prompts.get(event.data.source.rpcId) ?? null;
      }
    }
    return owner?.sessionId === session.id ? owner : null;
  }

  #matching(message) {
    return [...this.#pending].filter((pending) => (
      pending.chatId === message.chatId && pending.senderId === message.senderId
    ));
  }

  canAnswer(message) {
    return this.#matching(message).length > 0;
  }

  async #present(pending) {
    const index = pending.answers.length;
    let question = pending.questions[index];
    if (pending.permissionRequest) {
      question = { ...question, question: await permissionReason(this.#ctx, pending.permissionRequest, this.#logger) };
      if (!this.#pending.has(pending)) return;
    }
    const text = formatQuestion(question, index, pending.questions.length, pending.token);
    try {
      const result = await this.#send(pending.chatId, text);
      if (!result?.ok) throw new Error(result?.error || '发送提问失败');
      this.#logger('info', `提问已发送 → ${pending.chatId}（${index + 1}/${pending.questions.length}）`);
    } catch (error) {
      // The native answerer stays usable if WeChat delivery fails.
      this.#logger('error', `提问发送失败 → ${pending.chatId}：${error?.message ?? error}`);
      if (pending.approval) pending.settle(false, questionError('审批发送失败', 'DELIVERY_FAILED'));
    }
  }

  #ask(request, next) {
    const owner = this.#owner(request?.agent?.session);
    if (!owner || !request.questions?.length) return next();
    if (request.signal?.aborted) return Promise.reject(questionError('提问已取消', 'ASK_ABORTED'));

    // Like dsh-im, race native UI and IM with a private question lifetime.
    // Aborting the enclosing turn merely to retire a Web card kills other tools.
    const turnSignal = request.signal;
    const lifetime = new AbortController();
    const onTurnAbort = () => lifetime.abort(turnSignal?.reason);
    turnSignal?.addEventListener('abort', onTurnAbort, { once: true });
    request.signal = lifetime.signal;
    let pending;
    const im = new Promise((resolve, reject) => {
      const onAbort = () => pending.settle(false, questionError('提问已取消', 'ASK_ABORTED'));
      pending = {
        ...owner, questions: request.questions, answers: [], approval: request.approval, permissionRequest: request.permissionRequest,
        token: Math.random().toString(36).slice(2, 8), busy: false,
        settle: (ok, value) => {
          if (!this.#pending.delete(pending)) return;
          lifetime.signal.removeEventListener('abort', onAbort);
          if (ok) resolve(value);
          else reject(value);
        },
        cancel: () => {
          pending.settle(false, questionError('插件已停止，提问已取消', 'ASK_ABORTED'));
          lifetime.abort(questionError('插件已停止', 'ASK_ABORTED'));
        },
      };
      this.#pending.add(pending);
      lifetime.signal.addEventListener('abort', onAbort, { once: true });
    });
    let answeredOnWechat = false;
    const native = Promise.resolve().then(next).catch((error) => {
      if (error?.code !== 'NO_PROVIDER' && error?.code !== 'ASK_ABORTED') {
        this.#logger('warn', `网页提问通道不可用：${error?.message ?? error}`);
      }
      return new Promise(() => {});
    });
    void this.#present(pending);
    return Promise.race([
      native,
      im.then(
        (value) => { answeredOnWechat = true; return value; },
        (error) => { answeredOnWechat = true; throw error; },
      ),
    ]).finally(() => {
      pending.settle(false, questionError('提问已在其他端处理', 'ASK_ABORTED'));
      turnSignal?.removeEventListener('abort', onTurnAbort);
      if (answeredOnWechat) lifetime.abort(questionError('已在微信回答', 'ASK_ABORTED'));
    });
  }

  /** Consume an answer before it can become a new queued agent prompt. */
  async answer(message) {
    let matches = this.#matching(message);
    if (!matches.length) return false;
    let text = message.text.trim();
    const explicit = /^\/answer\s+(\S+)\s+([\s\S]+)$/i.exec(text);
    if (explicit) {
      matches = matches.filter((pending) => pending.token === explicit[1]);
      text = explicit[2].trim();
    }
    if (matches.length !== 1) {
      await this.#send(message.chatId, '请使用题目下方的 /answer 标识回复，避免回答到其他提问。');
      return true;
    }
    const pending = matches[0];
    if (pending.approval && !explicit) {
      await this.#send(message.chatId, `请明确回复 /answer ${pending.token} 拒绝 或 /answer ${pending.token} 允许一次`);
      return true;
    }
    if (pending.busy) return true;
    pending.busy = true;
    try {
      if (/^\/skip$/i.test(text)) {
        pending.settle(false, questionError('用户跳过了提问', 'ASK_CANCELLED'));
        await this.#send(message.chatId, '已跳过提问。');
        return true;
      }
      const answer = parseQuestionAnswer(pending.questions[pending.answers.length], text);
      if (pending.approval && !answer.selected?.length) {
        await this.#send(message.chatId, '审批只能选择“拒绝”或“允许一次”。');
        return true;
      }
      if (answer.error) {
        await this.#send(message.chatId, answer.error);
        return true;
      }
      pending.answers.push(answer);
      if (pending.answers.length === pending.questions.length) {
        pending.settle(true, { answers: pending.answers });
      } else {
        await this.#present(pending);
      }
      return true;
    } finally {
      pending.busy = false;
    }
  }

  cancelChat(chatId) {
    for (const pending of [...this.#pending]) if (pending.chatId === chatId) pending.cancel();
  }

  dispose() {
    this.#dispose?.();
    this.#disposeApproval?.();
    for (const pending of [...this.#pending]) pending.cancel();
    this.#prompts.clear();
  }
}

function questionError(message, code) {
  return Object.assign(new Error(message), { name: 'UserQuestionError', code });
}

export function formatQuestion(question, index, total, token) {
  return [
    `需要你回答（${index + 1}/${total}）`,
    question.header || '',
    question.question,
    question.detail || '',
    ...(question.options ?? []).map((option, i) => `${i + 1}. ${option.label}${option.description ? `：${option.description}` : ''}`),
    question.multiSelect ? '回复选项编号，可用逗号分隔多选；也可直接回复文字。' : '回复选项编号，或直接回复文字。',
    '多道题会依次展示；回复 /skip 跳过。纯数字文本请加“文字:”前缀。',
    `若同时有多条提问，请回复 /answer ${token} 你的答案`,
  ].filter(Boolean).join('\n\n');
}

export function parseQuestionAnswer(question, text) {
  const custom = /^(?:文字|text)[:：]\s*([\s\S]+)$/i.exec(text);
  if (custom) return { id: question.id, selected: [], custom: custom[1].trim() };
  const options = question.options ?? [];
  if (options.length && /^\d+(?:[\s,，、]+\d+)*$/.test(text)) {
    const numbers = text.split(/[\s,，、]+/).map(Number);
    if (numbers.some((n) => n < 1 || n > options.length) || new Set(numbers).size !== numbers.length) {
      return { error: `请回复 1–${options.length} 范围内的选项编号，编号不要重复。` };
    }
    if (!question.multiSelect && numbers.length > 1) return { error: '这道题只能选择一个选项。' };
    return { id: question.id, selected: numbers.map((n) => options[n - 1].label) };
  }
  const option = options.find((item) => item.label === text);
  return option ? { id: question.id, selected: [option.label] } : { id: question.id, selected: [], custom: text };
}
