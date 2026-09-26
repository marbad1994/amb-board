const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: options.body instanceof FormData ? undefined : { 'content-type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // projects
  listProjects: () => request('/projects'),
  createProject: (name, color) => request('/projects', { method: 'POST', body: JSON.stringify({ name, color }) }),
  getProject: (id) => request(`/projects/${id}`),
  updateProject: (id, data) => request(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),

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
};
