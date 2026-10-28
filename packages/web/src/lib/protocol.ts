export type ProtocolPolicy = {
    imap: boolean;
    smtp: boolean;
    pop3: boolean;
    hostname: string;
};
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<{
    success: true;
    data: T;
}> { const r = await fetch('/api' + path, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const v = await r.json(); if (!r.ok || !v.success)
    throw Error(v.error || 'Request failed'); return v; }
export const protocolApi = { users: (q: string) => call<{
        id: string;
        email: string;
        display_name: string;
        enabled: number;
    }[]>('/admin/protocol/users?q=' + encodeURIComponent(q)), settings: () => call<{
        policy: ProtocolPolicy;
        passwords: {
            id: string;
            name: string;
            created_at: string;
            last_used_at: string | null;
            revoked_at: string | null;
        }[];
    }>('/protocol'), create: (name: string, password?: string) => call<{
        password: string;
    }>('/protocol', 'POST', { name, password }), revoke: (id: string) => call('/protocol/' + id, 'DELETE'), policy: () => call<ProtocolPolicy>('/admin/protocol'), save: (v: ProtocolPolicy) => call<ProtocolPolicy>('/admin/protocol', 'PUT', v), access: (id: string, enabled: boolean) => call('/admin/protocol/users/' + encodeURIComponent(id), 'PUT', { enabled }) };
