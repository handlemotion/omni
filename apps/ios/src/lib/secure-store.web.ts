const store = () => globalThis.localStorage;

/** Expo's web target has no `expo-secure-store`: the same calls keep values in `localStorage`. */
export const getItem = (key: string) => store().getItem(key);
export const setItem = (key: string, value: string) => store().setItem(key, value);
export const getItemAsync = async (key: string) => getItem(key);
export const setItemAsync = async (key: string, value: string) => setItem(key, value);
export const deleteItemAsync = async (key: string) => store().removeItem(key);
