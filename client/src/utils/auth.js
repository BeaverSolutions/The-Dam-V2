const TOKEN_KEY = 'dam_token';
const USER_KEY = 'dam_user';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};
export const isAuthenticated = () => !!getToken();
export const getUser = () => {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch {
    return null;
  }
};
export const setUser = (user) => localStorage.setItem(USER_KEY, JSON.stringify(user));
