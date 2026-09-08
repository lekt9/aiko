import { useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { MiniAppNavigationContext } from "./mini-app-navigation";
import { createPortal } from "react-dom";
import { ArrowLeft } from "lucide-react";

/** A full Mini App page, with Telegram's native Back button and no nested sheet. */
export function MiniAppScreen({title,children,close}:{title:string;children:ReactNode;close:()=>void}) {
  const navigation = useContext(MiniAppNavigationContext);
  const id=useId(),root=useRef<HTMLDivElement>(null),back=useRef(close);back.current=close;
  useEffect(()=>{
    const prior=document.activeElement as HTMLElement|null;
    const hidden=[...document.body.children].filter(el=>el!==root.current) as HTMLElement[];
    const inert=hidden.map(el=>el.inert);hidden.forEach(el=>{el.inert=true;});
    const overflow=document.body.style.overflow;document.body.style.overflow="hidden";
    const webApp=(window as any).Telegram?.WebApp;
    const onBack=()=>back.current();webApp?.BackButton?.show();webApp?.BackButton?.onClick(onBack);
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return ()=>{hidden.forEach((el,i)=>{el.inert=inert[i]!;});document.body.style.overflow=overflow;webApp?.BackButton?.offClick(onBack);webApp?.BackButton?.hide();if(prior?.isConnected)prior.focus();};
  },[]);
  const content=<div ref={root} className="mini-app-screen" role="region" aria-labelledby={id} onKeyDown={e=>{if(e.key==="Escape")back.current();}}>
    <header className="mini-app-screen-header"><button className="mini-app-back" onClick={()=>back.current()}><ArrowLeft size={20}/><span>Back</span></button><h2 id={id}>{title}</h2></header>
    {navigation}
    <div className="mini-app-screen-body">{children}</div>
  </div>;
  return typeof document === "undefined" ? content : createPortal(content,document.body);
}
