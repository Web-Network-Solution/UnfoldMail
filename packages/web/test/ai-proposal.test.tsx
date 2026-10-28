import { cleanup,render,fireEvent,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { AIAction,AITurn,Email } from '@email-service/shared';
import AIProposal from '../src/components/AIProposal';
import { aiApi } from '../src/lib/ai';
import { emailApi } from '../src/lib/api';
import { useMailStore } from '../src/stores';
vi.mock('../src/lib/ai',()=>({aiApi:{decide:vi.fn(),editProposal:vi.fn()}}));
vi.mock('../src/lib/api',()=>({emailApi:{get:vi.fn()}}));
const action:AIAction={id:'a',kind:'draft',status:'pending',data:{to:'customer@example.com',subject:'Subject',body:'Clean draft'},review:{status:'cleaned',originalBody:'Draft saved.\nOriginal text',message:'Commentary removed'}};
const turn:AITurn={id:'turn',mode:'drafts',prompt:'Draft',text:'Review',status:'complete',createdAt:1,step:1,attempts:1,sources:[],activity:[],actions:[action]};
beforeEach(()=>useMailStore.setState({isComposeOpen:false}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('restores the original for editing without silently changing or approving the saved proposal',async()=>{
  render(<AIProposal action={action} turn={turn} enabled busy={false} perform={async fn=>{await fn();}} onCompose={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Restore original for review'}));expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(action.review!.originalBody);expect(aiApi.decide).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Save draft edits'}));await waitFor(()=>expect(aiApi.editProposal).toHaveBeenCalledWith('turn','a',{to:'customer@example.com',subject:'Subject',body:action.review!.originalBody}));
});
it('saves the approved draft then opens that exact saved email in the composer',async()=>{
  const email={id:'draft-id',bodyHtml:'<p>Clean draft</p>'} as Email,onCompose=vi.fn();
  vi.mocked(aiApi.decide).mockResolvedValue({success:true,data:{...turn,actions:[{...action,status:'applied',result:{emailId:'draft-id'}}]}});vi.mocked(emailApi.get).mockResolvedValue({success:true,data:email});
  render(<AIProposal action={action} turn={turn} enabled busy={false} perform={async fn=>{await fn();}} onCompose={onCompose}/>);
  fireEvent.click(screen.getByRole('button',{name:'Save draft & open composer'}));await waitFor(()=>expect(onCompose).toHaveBeenCalled());expect(useMailStore.getState().composeDraft).toEqual(email);expect(aiApi.decide).toHaveBeenCalledTimes(1);
});
it('does not replace an existing compose session',()=>{
  useMailStore.setState({isComposeOpen:true});render(<AIProposal action={action} turn={turn} enabled busy={false} perform={async fn=>{await fn();}} onCompose={()=>{}}/>);
  expect((screen.getByRole('button',{name:'Save draft & open composer'}) as HTMLButtonElement).disabled).toBe(true);
});
