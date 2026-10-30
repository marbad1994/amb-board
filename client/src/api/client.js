const BASE = '/api';

let workspaceId = null;
let onUnauthorized = () => {};

export function setWorkspaceId(id) {
  workspaceId = id;
}
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(path, options = {}) {
  const headers = options.body instanceof FormData ? {} : { 'content-type': 'application/json' };
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  const res = await fetch(`${BASE}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {
      // ignore
    }
    // an expired/revoked session on a data call sends the user back to sign-in
    if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/register')) onUnauthorized();
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

const json = (method, body) => ({ method, body: JSON.stringify(body ?? {}) });

export const api = {
  // auth
  me: () => request('/auth/me'),
  login: (email, password) => request('/auth/login', json('POST', { email, password })),
  register: (data) => request('/auth/register', json('POST', data)),
  logout: () => request('/auth/logout', { method: 'POST' }),
  logoutAll: () => request('/auth/logout-all', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) =>
    request('/auth/password', json('POST', { currentPassword, newPassword })),

  // workspaces
  listWorkspaces: () => request('/workspaces'),
  createWorkspace: (name) => request('/workspaces', json('POST', { name })),
  renameWorkspace: (id, name) => request(`/workspaces/${id}`, json('PATCH', { name })),
  listMembers: (id) => request(`/workspaces/${id}/members`),
  setMemberRole: (id, userId, role) => request(`/workspaces/${id}/members/${userId}`, json('PATCH', { role })),
  removeMember: (id, userId) => request(`/workspaces/${id}/members/${userId}`, { method: 'DELETE' }),
  listInvitations: (id) => request(`/workspaces/${id}/invitations`),
  invite: (id, email, role) => request(`/workspaces/${id}/invitations`, json('POST', { email, role })),
  revokeInvitation: (id, invId) => request(`/workspaces/${id}/invitations/${invId}`, { method: 'DELETE' }),
  acceptInvitation: (token) => request('/invitations/accept', json('POST', { token })),

  // dashboard + life areas
  dashboard: () => request('/dashboard'),
  listLifeAreas: (includeArchived = false) => request(`/life-areas${includeArchived ? '?archived=1' : ''}`),
  createLifeArea: (data) => request('/life-areas', json('POST', data)),
  updateLifeArea: (id, data) => request(`/life-areas/${id}`, json('PATCH', data)),
  addSubcategory: (id, name) => request(`/life-areas/${id}/subcategories`, json('POST', { name })),
  removeSubcategory: (id, subId) => request(`/life-areas/${id}/subcategories/${subId}`, { method: 'DELETE' }),

  // projects
  listProjects: ({ archived = false, lifeArea } = {}) => {
    const q = new URLSearchParams();
    if (archived) q.set('archived', '1');
    if (lifeArea) q.set('lifeArea', lifeArea);
    const s = q.toString();
    return request(`/projects${s ? `?${s}` : ''}`);
  },
  createProject: (name, color, lifeAreaId) => request('/projects', json('POST', { name, color, lifeAreaId })),
  getProject: (id) => request(`/projects/${id}`),
  updateProject: (id, data) => request(`/projects/${id}`, json('PATCH', data)),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),

  // finance
  financeSummary: (month) => request(`/finance/summary?month=${month}`),
  listTransactions: (params = {}) => request(`/finance/transactions?${new URLSearchParams(params)}`),
  createTransaction: (data) => request('/finance/transactions', json('POST', data)),
  voidTransaction: (id) => request(`/finance/transactions/${id}`, { method: 'DELETE' }),
  updateTransaction: (id, data) => request(`/finance/transactions/${id}`, json('PATCH', data)),
  listCategories: () => request('/finance/categories'),
  listRecurring: () => request('/finance/recurring'),
  createRecurring: (data) => request('/finance/recurring', json('POST', data)),
  deleteRecurring: (id) => request(`/finance/recurring/${id}`, { method: 'DELETE' }),
  projectFinance: (id) => request(`/projects/${id}/finance`),
  setProjectBudget: (id, data) => request(`/projects/${id}/budget`, json('PUT', data)),
  downloadTransactionsCsv: async () => {
    const res = await fetch(`${BASE}/finance/transactions/export.csv`, { headers: workspaceId ? { 'x-workspace-id': workspaceId } : {} });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.blob();
  },

  // calendar
  calendar: (from, to) => request(`/calendar?from=${from}&to=${to}`),
  createEvent: (data) => request('/calendar/events', json('POST', data)),
  updateEvent: (id, data) => request(`/calendar/events/${id}`, json('PATCH', data)),
  deleteEvent: (id) => request(`/calendar/events/${id}`, { method: 'DELETE' }),

  // AI assistant
  listConversations: () => request('/ai/assistant/conversations'),
  getConversation: (id) => request(`/ai/assistant/conversations/${id}`),
  chat: (message, conversationId) => request('/ai/assistant/chat', json('POST', { message, conversationId })),
  approveProposal: (id) => request(`/ai/assistant/proposals/${id}/approve`, { method: 'POST' }),
  rejectProposal: (id) => request(`/ai/assistant/proposals/${id}/reject`, { method: 'POST' }),

  // AI insights
  aiStatus: () => request('/ai/status'),
  getProjectSummary: (id) => request(`/ai/projects/${id}/summary`),
  generateProjectSummary: (id, refresh = false) => request(`/ai/projects/${id}/summary`, json('POST', { refresh })),
  getBriefing: () => request('/ai/briefing'),
  generateBriefing: (refresh = false) => request('/ai/briefing', json('POST', { refresh })),

  // tasks, search, ideas
  listTasks: (view = 'open', project) => request(`/tasks?view=${view}${project ? `&project=${project}` : ''}`),
  search: (q) => request(`/search?q=${encodeURIComponent(q)}`),
  convertIdea: (id, data = {}) => request(`/ideas/${id}/convert`, json('POST', data)),
  addSubtask: (cardId, title) => request(`/cards/${cardId}/subtasks`, json('POST', { title })),
  updateSubtask: (cardId, id, data) => request(`/cards/${cardId}/subtasks/${id}`, json('PATCH', data)),
  deleteSubtask: (cardId, id) => request(`/cards/${cardId}/subtasks/${id}`, { method: 'DELETE' }),

  // columns
  listColumns: (projectId) => request(`/projects/${projectId}/columns`),
  createColumn: (projectId, name) =>
    request(`/projects/${projectId}/columns`, { method: 'POST', body: JSON.stringify({ name }) }),
  renameColumn: (columnId, name) =>
    request(`/projects/columns/${columnId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteColumn: (columnId) => request(`/projects/columns/${columnId}`, { method: 'DELETE' }),
  reorderColumns: (projectId, order) =>
    request(`/projects/${projectId}/columns/reorder`, { method: 'POST', body: JSON.stringify({ order }) }),

  // cards
  getCard: (id) => request(`/cards/${id}`),
  createCard: (columnId, data) =>
    request(`/cards/columns/${columnId}/cards`, { method: 'POST', body: JSON.stringify(data) }),
  updateCard: (id, data) => request(`/cards/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  moveCard: (id, data) => request(`/cards/${id}/move`, { method: 'POST', body: JSON.stringify(data) }),
  deleteCard: (id) => request(`/cards/${id}`, { method: 'DELETE' }),
  addComment: (cardId, data) =>
    request(`/cards/${cardId}/comments`, { method: 'POST', body: JSON.stringify(data) }),
  deleteComment: (cardId, commentId) =>
    request(`/cards/${cardId}/comments/${commentId}`, { method: 'DELETE' }),

  // attachments
  uploadAttachment: (cardId, file) => {
    const form = new FormData();
    form.append('file', file);
    return request(`/cards/${cardId}/attachments`, { method: 'POST', body: form });
  },
  deleteAttachment: (cardId, attachmentId) =>
    request(`/cards/${cardId}/attachments/${attachmentId}`, { method: 'DELETE' }),

  // idea notes
  listIdeas: () => request('/ideas'),
  createIdea: (data) => request('/ideas', { method: 'POST', body: JSON.stringify(data) }),
  updateIdea: (id, data) => request(`/ideas/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteIdea: (id) => request(`/ideas/${id}`, { method: 'DELETE' }),

  // translate
  translate: (text, sourceLang) =>
    request('/translate', { method: 'POST', body: JSON.stringify({ text, sourceLang }) }),

  // AI task helper
  aiParseTask: (projectId, text, sourceLang) =>
    request('/ai/parse-task', { method: 'POST', body: JSON.stringify({ projectId, text, sourceLang }) }),
};
