import { describe,it,expect } from 'vitest';
import { cleanDraftByLines } from '../src/services/ai-review';
describe('Deletion-only draft cleanup',()=>{
  it('removes only selected lines and preserves quotes and signatures exactly',()=>{
    const body='Draft saved.\nThank you for your detailed request. We will respond tomorrow.\nRegards,\nEmployee\n> Original message';
    expect(cleanDraftByLines(body,'{"removeLines":[0]}')).toBe(body.slice(13));
  });
  it.each(['{"removeLines":[1]}','{"removeLines":[2]}','{"removeLines":[99]}','{"removeLines":["0"]}','not JSON'])('rejects unsafe or invalid changes %s',response=>{
    expect(()=>cleanDraftByLines('Hello there\nVisit https://example.com\n> Keep this quoted reply',response)).toThrow();
  });
  it('rejects empty output and excessive deletion',()=>{expect(()=>cleanDraftByLines('A long message\nx','{"removeLines":[0]}')).toThrow();});
});
