import { fail } from './integrity.js';
const forbidden = /忽略.{0,12}(指令|规则)|覆盖.{0,12}(人格|规则)|修改.{0,12}(权限|核心人格)|泄露.{0,12}(密钥|密码)|(?:system|developer)\s*:|(?:api[_ -]?key|password|access[_ -]?token)\s*[:=]/iu;
const identifying = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{5,18}\b|(?:姓名|住址|身份证|真实姓名)\s*[:：]\s*\S+|(?:sk|sess|ghp)[-_][A-Za-z0-9_-]{8,}/iu;
const attributes = /(?:对方|群友|用户|此人).{0,8}(?:病史|性取向|宗教信仰|政治立场|身份证)/u;
export function safeText(text, limit = 500) {
  if (typeof text !== 'string' || !text.trim() || text.length > limit || forbidden.test(text) || identifying.test(text) || (attributes.test(text)||/病史|性取向|宗教信仰|政治立场|身份证/u.test(text))) fail('UNSAFE_OR_INVALID_TEXT');
  return text.trim();
}
export function redact(text, aliases = []) {
  let out = String(text ?? '').slice(0, 8000);
  if(/病史|性取向|宗教信仰|政治立场|诊断|病历|抑郁症/u.test(out))return '[SENSITIVE_CONTEXT_OMITTED]';
  out=out.replace(/(?:真实姓名|姓名|住址|身份证|QQ|手机号|电话|邮箱)\s*[:：]\s*[^\s，。;；]+/giu,'[IDENTITY_OMITTED]');
  for (const alias of aliases.filter(x => typeof x === 'string' && x)) out = out.split(alias).join('[PERSON]');
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[CONTACT]')
    .replace(/\b\d{5,18}\b/gu, '[IDENTIFIER]')
    .replace(/(?:sk|sess|ghp)[-_][A-Za-z0-9_-]{8,}/gu, '[SECRET]');
  if (attributes.test(out)) return '';
  return out;
}
