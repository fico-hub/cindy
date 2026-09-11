import { it, expect, vi } from 'vitest';
import { RemoteDesktopViewerSession, type DesktopViewerRequest } from '../remoteDesktopViewerSession';
import type { RemoteDesktopRequest } from '../remoteDesktop';

const caps={version:1,enabled:true,canControl:true,automaticReconnect:true,connectionTakeover:true,displays:[{id:'screen'}]};
function fixture(){
  const request=vi.fn(async(r:RemoteDesktopRequest):Promise<unknown>=>r.op==='capabilities'?caps:r.op==='start'?{lease:'lease',display:{id:'screen'},controlling:false}:{controlling:true});
  return {request,session:new RemoteDesktopViewerSession(request as DesktopViewerRequest)};
}
it('uses the same peer protocol for a normal start, explicit takeover and an older host',async()=>{
  const f=fixture();await f.session.connect({isCurrent:()=>true,takeover:true});
  expect(f.request.mock.calls[1][0]).toEqual({op:'start',displayId:'screen',takeover:true});
  f.session.stop();f.request.mockResolvedValueOnce({...caps,automaticReconnect:false});
  await expect(f.session.connect({isCurrent:()=>true,resume:true})).rejects.toThrow('CHANNEL_NOT_ALLOWED');
});
it('a heartbeat sent before a control transition cannot overwrite the confirmed result',async()=>{
  const f=fixture();await f.session.connect({isCurrent:()=>true});
  let resolve!:(value:unknown)=>void;
  f.request.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const heartbeat=f.session.heartbeat();await f.session.control(true);resolve({controlling:false});
  expect(await heartbeat).toEqual({controlling:true});
});
it('an uncertain release blocks takeover until a heartbeat reconciles and releases host input',async()=>{
  const f=fixture();await f.session.connect({isCurrent:()=>true});await f.session.control(true);
  f.request.mockRejectedValueOnce(new Error('INVOKE_TIMEOUT'));
  await expect(f.session.control(false)).rejects.toThrow('INVOKE_TIMEOUT');
  await expect(f.session.control(true)).rejects.toThrow('DESKTOP_INPUT_BUSY');
  f.request.mockResolvedValueOnce({controlling:true}).mockResolvedValueOnce({controlling:false});
  expect(await f.session.heartbeat()).toEqual({controlling:false});
  expect(f.request.mock.calls.at(-1)?.[0]).toEqual({op:'control',lease:'lease',enabled:false});
});
it('stop cancels a pending start and cleans up the returned lease without reopening',async()=>{
  const f=fixture();let finish!:(value:unknown)=>void;
  f.request.mockResolvedValueOnce(caps).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
  const connection=f.session.connect({isCurrent:()=>true});await Promise.resolve();f.session.stop();
  finish({lease:'late'});await expect(connection).rejects.toThrow('DESKTOP_VIDEO_STOPPED');
  expect(f.request.mock.calls.at(-1)?.[0]).toEqual({op:'stop',lease:'late'});
});
