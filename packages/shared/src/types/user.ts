// ─── User & Auth Types ────────────────────────────────────────────

export type UserRole = 'super_admin' | 'admin' | 'employee';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  mustResetPassword: boolean;
  signatureHtml: string;
  createdAt: string;
  updatedAt: string;
  /** Total emails sent (admin view only). */
  totalSent?: number;
  /** Total emails received (admin view only). */
  totalReceived?: number;
  /** Total storage used in bytes (admin view only). */
  storageUsed?: number;
}

export interface CreateUserRequest {
  email: string;
  displayName: string;
  password: string;
  role?: UserRole;
  mustResetPassword?: boolean;
}

export interface UpdateUserRequest {
  displayName?: string;
  role?: UserRole;
  mustResetPassword?: boolean;
  newPassword?: string;
}

export interface BulkCreateUsersRequest {
  /** CSV content: email,displayName,password,mustResetPassword */
  csvContent: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ResetPasswordRequest {
  currentPassword: string;
  newPassword: string;
}
