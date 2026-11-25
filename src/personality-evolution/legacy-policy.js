export function legacyWriteBlocked(method, pathname) {
 const prefix='/api/personality-learning/';
 return method==='POST' && pathname.startsWith(prefix) && !pathname.startsWith(prefix+'v2/') && pathname!==prefix+'settings';
}
export function legacyWriteError() {
 const e=Error('REVIEW_API_REQUIRED');e.code='REVIEW_API_REQUIRED';e.status=410;throw e;
}
