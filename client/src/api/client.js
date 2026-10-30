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

  // my day, goals, habits, notes, documents
  myDay: () => request('/my-day'),
  listGoals: (status) => request(`/goals${status ? `?status=${status}` : ''}`),
  createGoal: (data) => request('/goals', json('POST', data)),
  updateGoal: (id, data) => request(`/goals/${id}`, json('PATCH', data)),
  deleteGoal: (id) => request(`/goals/${id}`, { method: 'DELETE' }),
  addMilestone: (id, title, due_date) => request(`/goals/${id}/milestones`, json('POST', { title, due_date: due_date || null })),
  updateMilestone: (id, mid, data) => request(`/goals/${id}/milestones/${mid}`, json('PATCH', data)),
  deleteMilestone: (id, mid) => request(`/goals/${id}/milestones/${mid}`, { method: 'DELETE' }),
  linkGoalProject: (id, projectId) => request(`/goals/${id}/projects/${projectId}`, { method: 'PUT' }),
  unlinkGoalProject: (id, projectId) => request(`/goals/${id}/projects/${projectId}`, { method: 'DELETE' }),
  listHabits: () => request('/habits'),
  createHabit: (data) => request('/habits', json('POST', data)),
  updateHabit: (id, data) => request(`/habits/${id}`, json('PATCH', data)),
  checkHabit: (id, date, done) => request(`/habits/${id}/entries/${date}`, { method: 'PUT', body: JSON.stringify({ done }) }),
  listChallenges: () => request('/habits/challenges/all'),
  createChallenge: (data) => request('/habits/challenges', json('POST', data)),
  deleteChallenge: (id) => request(`/habits/challenges/${id}`, { method: 'DELETE' }),
  listNotes: (params = {}) => request(`/notes?${new URLSearchParams(params)}`),
  createNote: (data) => request('/notes', json('POST', data)),
  updateNote: (id, data) => request(`/notes/${id}`, json('PATCH', data)),
  deleteNote: (id) => request(`/notes/${id}`, { method: 'DELETE' }),
  listDocuments: () => request('/documents'),
  uploadDocument: (file, extra = {}) => {
    const f = new FormData();
    f.append('file', file);
    for (const [k, v] of Object.entries(extra)) if (v) f.append(k, v);
    return request('/documents', { method: 'POST', body: f });
  },
  deleteDocument: (id) => request(`/documents/${id}`, { method: 'DELETE' }),
  downloadDocument: async (id) => {
    const res = await fetch(`${BASE}/documents/${id}/download`, { headers: workspaceId ? { 'x-workspace-id': workspaceId } : {} });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.blob();
  },

  // budget builder, charts, AI budget
  bulkBudget: (data) => request('/finance/budget/bulk', json('PUT', data)),
  financeTrend: (months = 6) => request(`/finance/trend?months=${months}`),
  categoryUsage: (id) => request(`/finance/categories/${id}/usage`),
  deleteCategory: (id, moveTo) => request(`/finance/categories/${id}${moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : ''}`, { method: 'DELETE' }),
  createCategory: (name, parentId) => request('/finance/categories', json('POST', { name, parentId: parentId || null })),
  aiBudgetDraft: (formData) => request('/finance/ai-budget/draft', { method: 'POST', body: formData }),
  applyAiBudget: (id, data) => request(`/finance/ai-budget/drafts/${id}/apply`, json('POST', data)),

  // notifications, budgets, savings, debts, reviews
  notifications: () => request('/notifications'),
  refreshNotifications: () => request('/notifications/refresh', { method: 'POST' }),
  readNotification: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
  readAllNotifications: () => request('/notifications/read-all', { method: 'POST' }),
  notificationPrefs: () => request('/notifications/preferences'),
  assistantSettings: () => request('/ai/assistant/settings'),
  setAssistantSettings: (data) => request('/ai/assistant/settings', json('PUT', data)),
  testAutomationStep: (data) => request('/automations/test-step', json('POST', data)),
  skillLibrary: () => request('/ai/assistant/skills/library'),
  importSkill: (data) => request('/ai/assistant/skills/import', json('POST', data)),
  deleteSkill: (id) => request(`/ai/assistant/skills/${id}`, { method: 'DELETE' }),
  stopSkill: (conversationId) => request(`/ai/assistant/conversations/${conversationId}/skill/stop`, { method: 'POST' }),
  listConnections: () => request('/ai/assistant/connections'),
  addConnection: (data) => request('/ai/assistant/connections', json('POST', data)),
  testConnection: (id) => request(`/ai/assistant/connections/${id}/test`, json('POST', {})),
  deleteConnection: (id) => request(`/ai/assistant/connections/${id}`, { method: 'DELETE' }),
  copyToWorkspace: (data) => request('/transfer', json('POST', data)),
  sendTestEmail: () => request('/notifications/email-test', json('POST', {})),
  setNotificationPrefs: (data) => request('/notifications/preferences', json('PUT', data)),
  monthBudget: (month) => request(`/finance/budget?month=${month}`),
  setMonthBudget: (data) => request('/finance/budget', json('PUT', data)),
  removeMonthBudget: (month, categoryId, currency) => request(`/finance/budget?month=${month}&categoryId=${categoryId}&currency=${currency}`, { method: 'DELETE' }),
  listSavings: () => request('/finance/savings'),
  createSavings: (data) => request('/finance/savings', json('POST', data)),
  addSavingsEntry: (id, data) => request(`/finance/savings/${id}/entries`, json('POST', data)),
  archiveSavings: (id) => request(`/finance/savings/${id}`, json('PATCH', { archived: true })),
  listDebts: () => request('/finance/debts'),
  createDebt: (data) => request('/finance/debts', json('POST', data)),
  addDebtPayment: (id, data) => request(`/finance/debts/${id}/payments`, json('POST', data)),
  archiveDebt: (id) => request(`/finance/debts/${id}`, json('PATCH', { archived: true })),
  getReview: (period) => request(`/ai/review/${period}`),
  generateReview: (period, refresh = false) => request(`/ai/review/${period}`, json('POST', { refresh })),

  // assistant platform: suggestions, reports, tokens
  suggestions: (context) => request(`/ai/assistant/suggestions${context ? `?context=${encodeURIComponent(context)}` : ''}`),
  dismissSuggestion: (key, days = 1) => request('/ai/assistant/suggestions/dismiss', json('POST', { key, days })),
  automationMeta: () => request('/automations/meta'),
  listPairings: () => request('/browser/pairings'),
  createPairing: (name) => request('/browser/pairings', json('POST', { name })),
  deletePairing: (id) => request(`/browser/pairings/${id}`, { method: 'DELETE' }),
  emailTemplates: () => request('/automations/templates'),
  createEmailTemplate: (data) => request('/automations/templates', json('POST', data)),
  updateEmailTemplate: (id, data) => request(`/automations/templates/${id}`, json('PATCH', data)),
  deleteEmailTemplate: (id) => request(`/automations/templates/${id}`, { method: 'DELETE' }),
  emailPreview: (data) => request('/automations/email-preview', json('POST', data)),
  automationTools: () => request('/automations/tools'),
  listAutomations: () => request('/automations'),
  getAutomation: (id) => request(`/automations/${id}`),
  createAutomation: (data) => request('/automations', json('POST', data)),
  updateAutomation: (id, data) => request(`/automations/${id}`, json('PATCH', data)),
  deleteAutomation: (id) => request(`/automations/${id}`, { method: 'DELETE' }),
  runAutomation: (id) => request(`/automations/${id}/run`, json('POST', {})),
  listReports: () => request('/reports'),
  createReport: (data) => request('/reports', json('POST', data)),
  getReport: (id) => request(`/reports/${id}`),
  deleteReport: (id) => request(`/reports/${id}`, { method: 'DELETE' }),
  downloadReport: async (id) => {
    const res = await fetch(`${BASE}/reports/${id}/download`, { headers: workspaceId ? { 'x-workspace-id': workspaceId } : {} });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.blob();
  },
  listTokens: () => request('/tokens'),
  createToken: (name) => request('/tokens', json('POST', { name })),
  revokeToken: (id) => request(`/tokens/${id}`, { method: 'DELETE' }),

  // AI assistant
  listConversations: () => request('/ai/assistant/conversations'),
  getConversation: (id) => request(`/ai/assistant/conversations/${id}`),
  chat: (message, conversationId, context) => request('/ai/assistant/chat', json('POST', { message, conversationId, context })),
  approveProposal: (id, body = {}) => request(`/ai/assistant/proposals/${id}/approve`, { method: 'POST', body: JSON.stringify(body) }),
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
  updateColumn: (columnId, data) =>
    request(`/projects/columns/${columnId}`, { method: 'PATCH', body: JSON.stringify(data) }),
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
