const USER_KEY = 'dam_user';

// Token is now stored in an httpOnly cookie set by the server.
// These are kept as no-ops so existing call sites don't break.
export const getToken = () => null;
export const setToken = () => {};
export const clearToken = () => localStorage.removeItem(USER_KEY);

// Auth is determined by whether we have a user object in localStorage.
// The cookie (invisible to JS) is the actual credential.
export const isAuthenticated = () => !!getUser();

export const getUser = () => {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch {
    return null;
  }
};
export const setUser = (user) => localStorage.setItem(USER_KEY, JSON.stringify(user));
