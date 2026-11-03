import Head from 'next/head';
import {useEffect} from 'react';
export default function Screen({content}) {
 useEffect(()=>{
  for(const [key,value] of Object.entries(content.bodyAttrs))document.body.setAttribute(key,value);
  let cancelled=false;
  (async()=>{for(const src of content.scripts){if(cancelled)return;await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(new Error('Could not load '+src));document.body.appendChild(s);});}})().catch(e=>{console.error(e);});
  return ()=>{cancelled=true;};
 },[]);
 return <><Head><title>{content.title}</title><meta name="viewport" content="width=device-width, initial-scale=1"/>{content.links.map((p,i)=><link key={i} {...p}/>)}</Head><div dangerouslySetInnerHTML={{__html:content.markup}}/></>;
}
