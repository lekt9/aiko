export const THEMES = ["mono", "mono-light", "dark", "light", "midnight", "ember"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
