const { Buffer } = require('node:buffer');
function usable(auth, { rejectedToken, now = Date.now() } = {}) {
  if (!auth || typeof auth.token !== 'string' || !auth.token.trim() || auth.token === rejectedToken) return false;
  try {
    const claims = JSON.parse(Buffer.from(auth.token.split('.')[1], 'base64url'));
    if (claims.exp && claims.exp * 1000 < now + 60000) return false;
  } catch { /* Opaque tokens are validated by Quixel's API. */ }
  return true;
}
module.exports = { usable };
