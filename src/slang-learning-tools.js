export function slangApproval(entries, owner) {
  if (!owner || entries.length !== 1 || String(entries[0].senderId) !== String(owner)) return null;
  const match = /^黑话审核\s+([A-Za-z0-9_-]{1,100})\s+(通过|驳回|重试)$/.exec(String(entries[0].text || '').trim());
  return match ? { id: match[1], decision: ({ 通过: 'approve', 驳回: 'reject', 重试: 'retry' })[match[2]], actor: String(owner) } : null;
}
export function slangToolDefs() {
  const tool = (name, description, properties, required, run) => ({ name, feature: 'slangLearning', description,
    parameters: { type: 'object', properties, required },
    async execute(ctx, args) {
      if (!ctx.slangLearning?.active) throw Error('黑话学习未启用');
      return { content: JSON.stringify(await run(ctx, args)) };
    } });
  const str = { type: 'string' };
  return [
    tool('slang_query', '在当前会话查询相关已确认黑话，候选不会当作事实返回。', { query: str }, ['query'], (c,a) => c.slangLearning.query(c.chatKey,a.query)),
    tool('slang_submit', '从当前聊天的真实消息提交待研究黑话，不能自动审核。', { content: str, messageId: str }, ['content','messageId'], (c,a) => {
      const m = c.store.recent(c.chatKey,{limit:60}).find(m => String(m.mid) === String(a.messageId) && !m.self);
      if (!m) throw Error('来源消息不在当前会话');
      return c.slangLearning.submit(c.chatKey,a.content,m.text,m.mid,m.senderId);
    }),
    tool('slang_feedback', '提交当前会话词条纠错，保留原词条等待管理员处理。', { id: str, note: str }, ['id','note'], (c,a) => c.slangLearning.feedback(c.chatKey,a.id,a.note,'model:' + c.chatKey)),
    tool('slang_review', '仅执行主人本轮明确发出的“黑话审核 ID 通过/驳回/重试”命令。', { id: str, decision: { type:'string',enum:['approve','reject','retry'] } }, ['id','decision'], (c,a) => {
      const approval = c.slangApproval;
      if (!approval || approval.id !== a.id || approval.decision !== a.decision) throw Error('没有匹配的主人审核指令');
      return c.slangLearning.review(a.id,a.decision,approval.actor);
    })
  ];
}
