// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { mountRemoteDesktopViewer } from '@cindy/maker-shared/remote-desktop-viewer';
import { DESKTOP_KEY_CODES, REMOTE_DESKTOP_NETWORK } from '@cindy/device-link';

let viewer: ReturnType<typeof mountRemoteDesktopViewer>;
let messages: Record<string,unknown>[];
let stage: HTMLElement;
beforeEach(()=>{
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver',class {observe(){}disconnect(){}});
  vi.stubGlobal('matchMedia',()=>({matches:true}));
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();
  document.body.innerHTML='<div id="stage"><img id="image"><video id="video"></video><div id="cursor"><img id="cursor-image"></div></div><textarea id="keyboard-input"></textarea><div id="mouse-buttons"><button id="mouse-left"></button><button id="mouse-right"></button><button id="mouse-wheel"><span id="mouse-wheel-grip"></span></button></div>';
  stage=document.getElementById('stage')!;
  Object.defineProperties(stage,{clientWidth:{value:1000},clientHeight:{value:600}});
  stage.setPointerCapture=vi.fn();
  vi.spyOn(stage,'getBoundingClientRect').mockReturnValue({x:0,y:52,left:0,top:52,width:1000,height:600,right:1000,bottom:652,toJSON(){}});
  messages=[];
  viewer=mountRemoteDesktopViewer(document,message=>{
    messages.push(message);
    if(message.type==='input')viewer.receive({type:'ack',epoch:'lease',sequence:message.sequence});
  },{desktop:true,net:REMOTE_DESKTOP_NETWORK,iceServers:[],keyCodes:DESKTOP_KEY_CODES});
  viewer.receive({type:'init',epoch:'lease',width:1000,height:600});
  viewer.receive({type:'control',enabled:true});
});
afterEach(()=>{viewer.dispose();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
function pointer(type:string,x=500,y=352,button=0){const e=new MouseEvent(type,{clientX:x,clientY:y,button,bubbles:true,cancelable:true});Object.defineProperty(e,'pointerId',{value:1});stage.dispatchEvent(e);}
function events(){return messages.flatMap(m=>m.type==='input'?m.events as Record<string,unknown>[]:[]);}
it('maps real mouse movement, right button and wheel to the picture below the toolbar',()=>{
  pointer('pointermove');vi.advanceTimersByTime(34);
  expect(events()).toContainEqual({kind:'move',x:.5,y:.5});
  expect(document.getElementById('cursor')!.style.display).toBe('none');
  pointer('pointerdown',500,352,2);pointer('pointerup',500,352,2);
  stage.dispatchEvent(new WheelEvent('wheel',{deltaY:32,bubbles:true,cancelable:true}));
  expect(events()).toContainEqual({kind:'button',button:2,down:true,x:.5,y:.5});
  expect(events()).toContainEqual({kind:'button',button:2,down:false,x:.5,y:.5});
  expect(events()).toContainEqual({kind:'scroll',dx:0,dy:32});
});
it('commits IME text once and never forwards local toolbar keyboard input',()=>{
  pointer('pointerdown');pointer('pointerup');
  const input=document.getElementById('keyboard-input') as HTMLTextAreaElement;
  input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
  input.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyN',key:'Process',isComposing:true,bubbles:true}));
  input.value='你好';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
  expect(events().filter(e=>e.kind==='text')).toEqual([{kind:'text',text:'你好'}]);
  input.blur();document.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyA',key:'a',bubbles:true}));
  vi.advanceTimersByTime(34);expect(events().some(e=>e.kind==='key'&&e.code==='KeyA')).toBe(false);
});
it('releases held buttons on window blur and disposal removes all timers',()=>{
  pointer('pointerdown');window.dispatchEvent(new Event('blur'));expect(events()).toContainEqual({kind:'release'});
  viewer.dispose();messages=[];vi.advanceTimersByTime(5000);expect(messages).toEqual([]);
});
