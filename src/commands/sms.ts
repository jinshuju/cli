import { API } from './shared.js';
import type { Command } from './types.js';

export const SMS: readonly Command[] = [
  {
    path: ['sms', 'status'],
    summary: 'List SMS signatures and templates with their review status and why a review failed',
    description: 'Your own signatures and templates, not those of the rest of the account.',
    request: () => ({ method: 'GET', path: `${API}/sms/audit_statuses` })
  }
];
