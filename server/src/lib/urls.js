// Shared guards for user-supplied media links.

/**
 * A user-supplied image/avatar URL is safe to render only when it is an absolute
 * http(s) URL or a scheme-less path (assets/…, /uploads/…). Anything carrying another
 * scheme — javascript:, data:, vbscript: — is rejected so a stored value can never turn
 * an <img>/:src binding into a script or navigation sink. An empty or absent value
 * clears the field and is allowed.
 */
export function isSafeMediaUrl(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  if (/^https?:\/\//i.test(value)) {
    return true;
  }
  // A leading "scheme:" that is not http(s) is rejected; a path with no scheme is fine.
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}
