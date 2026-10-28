import { describe, expect, it } from 'vitest';
import { addressError, filterErrors, findSettings, passwordFeedback } from '../../web/src/lib/settings';
import type { MailFilter } from '@email-service/shared';
const rule = (): MailFilter => ({id:'test', name:'Invoices',enabled:true,match:'all',conditions:{},actions:{star:true},stop:false});
describe('Settings validation and discovery', () => {
  it('finds common tasks using user vocabulary and combined terms', () => {
    expect(findSettings('password')[0].id).toBe('security');
    expect(findSettings('signature')[0].id).toBe('account');
    expect(findSettings('failed delivery')[0].id).toBe('activity');
    expect(findSettings('dark')[0].id).toBe('system');
    expect(findSettings('remote images')[0].id).toBe('system');
    expect(findSettings('forward address')[0].id).toBe('forwarding');
    expect(findSettings('no such setting')).toEqual([]);
  });
  it('validates full email addresses and rejects unsafe tokens', () => {
    for (const address of ['incomplete','a@b','a b@example.com','<a@example.com>']) expect(addressError(address)).not.toBe('');
    expect(addressError('employee+label@example.com')).toBe('');
  });
  it('identifies filter errors before making a request', () => {
    const r = rule(); r.name=' ';r.actions={};r.conditions={from:'bad',fromDomain:'https://example.com',minBytes:2048,maxBytes:1024};
    expect(Object.keys(filterErrors(r))).toEqual(expect.arrayContaining(['name','actions','from','fromDomain','maxBytes']));
    expect(filterErrors(rule())).toEqual({});
    r.conditions={maxBytes:Number.NaN};expect(filterErrors(r).maxBytes).toBeTruthy();
  });
});

it('reports password mismatch, minimum length, and reused password before submit', () => {
  expect(passwordFeedback('current-example','short','different',12)).toEqual({next:'Use at least 12 characters.',confirm:'Passwords do not match yet.'});
  expect(passwordFeedback('same-long-password','same-long-password','same-long-password',12).next).toContain('different');
  expect(passwordFeedback('old-example','new-example-long','new-example-long',12)).toEqual({next:'',confirm:''});
});
