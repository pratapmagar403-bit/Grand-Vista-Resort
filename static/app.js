/**
 * AI Chatbot - Pure Vanilla JavaScript Frontend
 * Interacts with FastAPI backend and SQLite database.
 */

(function () {
  'use strict';

  // --- State ---
  const state = {
    activeSessionId: null,
    sessions: [],
    isGenerating: false,
    abortController: null,
    searchQuery: '',
    stats: { total_sessions: 0, total_messages: 0 }
  };

  // --- DOM Elements ---
  const elements = {
    appContainer: document.getElementById('app-container'),
    chatSidebar: document.getElementById('chat-sidebar'),
    sidebarOverlay: document.getElementById('sidebar-overlay'),
    openSidebarBtn: document.getElementById('open-sidebar-btn'),
    closeSidebarBtn: document.getElementById('close-sidebar-btn'),
    newChatBtn: document.getElementById('new-chat-btn'),
    searchInput: document.getElementById('search-input'),
    sessionsContainer: document.getElementById('sessions-container'),
    sessionsCount: document.getElementById('sessions-count'),
    dbCountsText: document.getElementById('db-counts-text'),
    dbStatusText: document.getElementById('db-status-text'),
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    themeMoonIcon: document.getElementById('theme-moon-icon'),
    themeSunIcon: document.getElementById('theme-sun-icon'),

    activeChatTitle: document.getElementById('active-chat-title'),
    renameChatBtn: document.getElementById('rename-chat-btn'),
    chatActionsBtn: document.getElementById('chat-actions-btn'),
    chatActionsMenu: document.getElementById('chat-actions-menu'),
    actionExportMd: document.getElementById('action-export-md'),
    actionExportJson: document.getElementById('action-export-json'),
    actionClearChat: document.getElementById('action-clear-chat'),
    actionDeleteChat: document.getElementById('action-delete-chat'),

    messagesContainer: document.getElementById('messages-container'),
    welcomeScreen: document.getElementById('welcome-screen'),
    messageList: document.getElementById('message-list'),

    chatForm: document.getElementById('chat-form'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    stopBtn: document.getElementById('stop-btn'),

    renameDialog: document.getElementById('rename-dialog'),
    renameInput: document.getElementById('rename-input'),
    renameCancelBtn: document.getElementById('rename-cancel-btn'),
    renameConfirmBtn: document.getElementById('rename-confirm-btn'),

    confirmDialog: document.getElementById('confirm-dialog'),
    confirmDialogTitle: document.getElementById('confirm-dialog-title'),
    confirmDialogText: document.getElementById('confirm-dialog-text'),
    confirmCancelBtn: document.getElementById('confirm-cancel-btn'),
    confirmOkBtn: document.getElementById('confirm-ok-btn')
  };

  let confirmCallback = null;

  // --- Theme Management ---
  function initTheme() {
    const savedTheme = localStorage.getItem('chatbot_theme') || 'dark';
    applyTheme(savedTheme);

    elements.themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('chatbot_theme', next);
    });
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'light') {
      elements.themeMoonIcon.classList.add('hidden');
      elements.themeSunIcon.classList.remove('hidden');
      const hlLink = document.getElementById('highlight-theme');
      if (hlLink) hlLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
    } else {
      elements.themeMoonIcon.classList.remove('hidden');
      elements.themeSunIcon.classList.add('hidden');
      const hlLink = document.getElementById('highlight-theme');
      if (hlLink) hlLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
    }
  }

  // --- Markdown Parser Setup ---
  function parseMarkdown(text) {
    if (window.marked) {
      try {
        marked.setOptions({
          gfm: true,
          breaks: true,
          highlight: function (code, lang) {
            if (window.hljs) {
              const language = hljs.getLanguage(lang) ? lang : 'plaintext';
              return hljs.highlight(code, { language }).value;
            }
            return code;
          }
        });
        return marked.parse(text || '');
      } catch (err) {
        console.warn('Marked parse error, using fallback:', err);
      }
    }
    // Simple fallback
    return escapeHtml(text || '').replace(/\n/g, '<br>');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Format Relative Time ---
  function formatTimestamp(isoString) {
    if (!isoString) return '';
    try {
      const date = new Date(isoString.replace(' ', 'T') + (isoString.includes('Z') ? '' : 'Z'));
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / (1000 * 60));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return `${diffDays}d ago`;
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  // --- API Methods ---
  async function fetchSessions() {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error('Failed to fetch sessions');
      const data = await res.json();
      state.sessions = data.sessions || [];
      renderSessionsList();
      fetchDbStats();

      // If no active session, select first or create one
      if (!state.activeSessionId) {
        if (state.sessions.length > 0) {
          selectSession(state.sessions[0].id);
        } else {
          await createNewSession();
        }
      }
    } catch (err) {
      console.error('Error loading sessions:', err);
      elements.sessionsContainer.innerHTML = `
        <div class="sessions-empty">
          Failed to load chat history.<br>
          <button id="retry-sessions-btn" class="btn btn-secondary" style="margin-top:8px;font-size:12px;">Retry</button>
        </div>
      `;
      document.getElementById('retry-sessions-btn')?.addEventListener('click', fetchSessions);
    }
  }

  async function fetchDbStats() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        if (data.stats) {
          state.stats = data.stats;
          elements.dbCountsText.textContent = `${data.stats.total_sessions} chats · ${data.stats.total_messages} msgs`;
        }
      }
    } catch (err) {
      console.warn('Could not fetch DB stats:', err);
    }
  }

  async function createNewSession(customTitle) {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: customTitle || 'New Conversation' })
      });
      if (!res.ok) throw new Error('Failed to create session');
      const data = await res.json();
      const newSession = data.session;
      state.sessions.unshift(newSession);
      renderSessionsList();
      selectSession(newSession.id);
      fetchDbStats();
      closeMobileSidebar();
      elements.messageInput.focus();
    } catch (err) {
      console.error('Error creating new session:', err);
    }
  }

  async function loadSessionDetail(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) throw new Error('Failed to load session detail');
      const data = await res.json();
      const session = data.session;
      const messages = data.messages || [];

      elements.activeChatTitle.textContent = session.title;
      renderMessages(messages);
      scrollToBottom();
    } catch (err) {
      console.error('Error loading messages:', err);
    }
  }

  async function renameSession(sessionId, newTitle) {
    if (!newTitle || !newTitle.trim()) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() })
      });
      if (!res.ok) throw new Error('Failed to rename session');

      const s = state.sessions.find(x => x.id === sessionId);
      if (s) s.title = newTitle.trim();
      if (state.activeSessionId === sessionId) {
        elements.activeChatTitle.textContent = newTitle.trim();
      }
      renderSessionsList();
    } catch (err) {
      console.error('Error renaming session:', err);
    }
  }

  async function deleteSession(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete session');

      state.sessions = state.sessions.filter(s => s.id !== sessionId);
      renderSessionsList();
      fetchDbStats();

      if (state.activeSessionId === sessionId) {
        if (state.sessions.length > 0) {
          selectSession(state.sessions[0].id);
        } else {
          await createNewSession();
        }
      }
    } catch (err) {
      console.error('Error deleting session:', err);
    }
  }

  async function clearCurrentChat() {
    if (!state.activeSessionId) return;
    try {
      const res = await fetch(`/api/sessions/${state.activeSessionId}/clear`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed to clear messages');

      const s = state.sessions.find(x => x.id === state.activeSessionId);
      if (s) {
        s.message_count = 0;
        s.last_message = null;
      }
      renderSessionsList();
      renderMessages([]);
      fetchDbStats();
    } catch (err) {
      console.error('Error clearing chat:', err);
    }
  }

  function selectSession(sessionId) {
    state.activeSessionId = sessionId;
    renderSessionsList();
    loadSessionDetail(sessionId);
    closeMobileSidebar();
  }

  // --- Rendering UI ---
  function renderSessionsList() {
    elements.sessionsCount.textContent = state.sessions.length;

    const query = state.searchQuery.toLowerCase().trim();
    const filtered = query
      ? state.sessions.filter(s =>
          (s.title && s.title.toLowerCase().includes(query)) ||
          (s.last_message && s.last_message.toLowerCase().includes(query))
        )
      : state.sessions;

    if (filtered.length === 0) {
      elements.sessionsContainer.innerHTML = `
        <div class="sessions-empty">
          ${query ? 'No matching conversations' : 'No conversations yet'}
        </div>
      `;
      return;
    }

    elements.sessionsContainer.innerHTML = '';
    filtered.forEach(session => {
      const item = document.createElement('div');
      item.className = `session-item ${session.id === state.activeSessionId ? 'active' : ''}`;
      item.dataset.id = session.id;

      const timeText = formatTimestamp(session.updated_at || session.created_at);
      const snippet = session.last_message ? escapeHtml(session.last_message) : 'No messages yet';

      item.innerHTML = `
        <div class="session-info">
          <span class="session-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</span>
          <div class="session-meta">
            <span>${timeText}</span>
            <span>·</span>
            <span class="session-snippet">${snippet}</span>
          </div>
        </div>
        <div class="session-actions">
          <button class="session-action-btn edit" title="Rename" aria-label="Rename conversation">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
            </svg>
          </button>
          <button class="session-action-btn delete" title="Delete" aria-label="Delete conversation">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
            </svg>
          </button>
        </div>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.session-action-btn')) return;
        selectSession(session.id);
      });

      const editBtn = item.querySelector('.session-action-btn.edit');
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRenameModal(session.id, session.title);
      });

      const deleteBtn = item.querySelector('.session-action-btn.delete');
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openConfirmModal(
          'Delete Conversation',
          `Are you sure you want to delete "${session.title}"? All messages will be permanently deleted from SQLite.`,
          () => deleteSession(session.id)
        );
      });

      elements.sessionsContainer.appendChild(item);
    });
  }

  function renderMessages(messages) {
    if (!messages || messages.length === 0) {
      elements.welcomeScreen.classList.remove('hidden');
      elements.messageList.classList.add('hidden');
      elements.messageList.innerHTML = '';
      return;
    }

    elements.welcomeScreen.classList.add('hidden');
    elements.messageList.classList.remove('hidden');
    elements.messageList.innerHTML = '';

    messages.forEach(msg => {
      appendMessageToUI(msg.role, msg.content, msg.id, msg.created_at, false);
    });

    attachCodeCopyButtons();
  }

  function appendMessageToUI(role, content, messageId, createdAt, isStreaming = false) {
    elements.welcomeScreen.classList.add('hidden');
    elements.messageList.classList.remove('hidden');

    const item = document.createElement('div');
    item.className = `message-item ${role}`;
    if (messageId) item.dataset.id = messageId;

    const timeStr = createdAt ? formatTimestamp(createdAt) : 'Just now';

    if (role === 'user') {
      item.innerHTML = `
        <div class="message-avatar">You</div>
        <div class="message-body">
          <div class="message-bubble">${escapeHtml(content).replace(/\n/g, '<br>')}</div>
          <span class="message-time">${timeStr}</span>
        </div>
      `;
    } else {
      const parsedContent = isStreaming ? escapeHtml(content) : parseMarkdown(content);
      item.innerHTML = `
        <div class="message-avatar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L14.4 9.6L22 12L14.4 14.4L12 22L9.6 14.4L2 12L9.6 9.6L12 2Z"></path>
          </svg>
        </div>
        <div class="message-body">
          <div class="message-bubble markdown-content">${parsedContent}${isStreaming ? '<span class="typing-cursor"></span>' : ''}</div>
          <div class="message-actions">
            <span class="message-time">${timeStr}</span>
            <button class="msg-btn copy-msg-btn" title="Copy response">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            </button>
          </div>
        </div>
      `;

      const copyBtn = item.querySelector('.copy-msg-btn');
      copyBtn?.addEventListener('click', () => {
        navigator.clipboard.writeText(content);
        const span = copyBtn.querySelector('span');
        const orig = span.textContent;
        span.textContent = 'Copied!';
        setTimeout(() => { span.textContent = orig; }, 1500);
      });
    }

    elements.messageList.appendChild(item);
    return item;
  }

  function attachCodeCopyButtons() {
    const preBlocks = elements.messageList.querySelectorAll('pre');
    preBlocks.forEach(pre => {
      if (pre.querySelector('.code-header')) return;

      const code = pre.querySelector('code');
      if (!code) return;

      let lang = 'code';
      code.classList.forEach(cls => {
        if (cls.startsWith('language-')) lang = cls.replace('language-', '');
      });

      const header = document.createElement('div');
      header.className = 'code-header';
      header.innerHTML = `
        <span>${lang}</span>
        <button class="copy-code-btn" type="button">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy</span>
        </button>
      `;

      const btn = header.querySelector('.copy-code-btn');
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(code.innerText);
        const span = btn.querySelector('span');
        span.textContent = 'Copied!';
        setTimeout(() => { span.textContent = 'Copy'; }, 1500);
      });

      pre.insertBefore(header, code);
    });
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    });
  }

  // --- Message Submission & Streaming ---
  async function sendMessage(text) {
    if (!text || !text.trim() || state.isGenerating) return;
    const prompt = text.trim();

    // Clear input and reset height
    elements.messageInput.value = '';
    elements.messageInput.style.height = 'auto';

    // Append user message immediately
    appendMessageToUI('user', prompt, null, new Date().toISOString(), false);
    scrollToBottom();

    // Create placeholder assistant message
    const assistantItem = appendMessageToUI('assistant', '', null, new Date().toISOString(), true);
    const bubble = assistantItem.querySelector('.message-bubble');
    scrollToBottom();

    // Update UI state for streaming
    setGeneratingState(true);
    state.abortController = new AbortController();

    let fullResponse = '';

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: state.activeSessionId,
          message: prompt,
          stream: true
        }),
        signal: state.abortController.signal
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({ detail: 'Network response was not ok' }));
        throw new Error(errJson.detail || 'Server error');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.replace('data: ', '').trim();
            if (!dataStr) continue;

            try {
              const data = JSON.parse(dataStr);

              if (data.type === 'init') {
                if (data.session_id && data.session_id !== state.activeSessionId) {
                  state.activeSessionId = data.session_id;
                }
                if (data.title) {
                  elements.activeChatTitle.textContent = data.title;
                  const s = state.sessions.find(x => x.id === state.activeSessionId);
                  if (s) s.title = data.title;
                  renderSessionsList();
                }
              } else if (data.type === 'chunk') {
                fullResponse += data.text;
                bubble.innerHTML = parseMarkdown(fullResponse) + '<span class="typing-cursor"></span>';
                scrollToBottom();
              } else if (data.type === 'done') {
                if (data.message_id) assistantItem.dataset.id = data.message_id;
                if (data.title) {
                  elements.activeChatTitle.textContent = data.title;
                  const s = state.sessions.find(x => x.id === state.activeSessionId);
                  if (s) s.title = data.title;
                }
              } else if (data.type === 'error') {
                fullResponse = data.text || `Error: ${data.error}`;
                bubble.innerHTML = parseMarkdown(fullResponse);
              }
            } catch (jsonErr) {
              console.warn('Error parsing SSE chunk:', jsonErr);
            }
          }
        }
      }

      // Finalize message rendering without typing cursor
      bubble.innerHTML = parseMarkdown(fullResponse);
      attachCodeCopyButtons();
      scrollToBottom();

      // Refresh sessions list to update preview and last updated timestamp
      fetchSessions();
    } catch (err) {
      if (err.name === 'AbortError') {
        bubble.innerHTML = parseMarkdown(fullResponse + '\n\n*(Generation stopped by user)*');
      } else {
        bubble.innerHTML = `<span style="color:var(--danger-color);">Error generating response: ${escapeHtml(err.message)}</span>`;
      }
    } finally {
      setGeneratingState(false);
      state.abortController = null;
      attachCodeCopyButtons();
      scrollToBottom();
    }
  }

  function setGeneratingState(isGenerating) {
    state.isGenerating = isGenerating;
    if (isGenerating) {
      elements.sendBtn.classList.add('hidden');
      elements.stopBtn.classList.remove('hidden');
      elements.messageInput.setAttribute('disabled', 'true');
    } else {
      elements.sendBtn.classList.remove('hidden');
      elements.stopBtn.classList.add('hidden');
      elements.messageInput.removeAttribute('disabled');
      elements.messageInput.focus();
    }
  }

  // --- Modal Dialogs ---
  function openRenameModal(sessionId, currentTitle) {
    elements.renameInput.value = currentTitle || '';
    elements.renameDialog.showModal();
    elements.renameInput.select();

    const handleConfirm = () => {
      const val = elements.renameInput.value.trim();
      if (val) {
        renameSession(sessionId, val);
      }
      elements.renameDialog.close();
      cleanup();
    };

    const handleCancel = () => {
      elements.renameDialog.close();
      cleanup();
    };

    const handleKey = (e) => {
      if (e.key === 'Enter') handleConfirm();
      if (e.key === 'Escape') handleCancel();
    };

    function cleanup() {
      elements.renameConfirmBtn.removeEventListener('click', handleConfirm);
      elements.renameCancelBtn.removeEventListener('click', handleCancel);
      elements.renameInput.removeEventListener('keydown', handleKey);
    }

    elements.renameConfirmBtn.addEventListener('click', handleConfirm);
    elements.renameCancelBtn.addEventListener('click', handleCancel);
    elements.renameInput.addEventListener('keydown', handleKey);
  }

  function openConfirmModal(title, message, onOk) {
    elements.confirmDialogTitle.textContent = title;
    elements.confirmDialogText.textContent = message;
    confirmCallback = onOk;
    elements.confirmDialog.showModal();
  }

  elements.confirmOkBtn.addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    elements.confirmDialog.close();
    confirmCallback = null;
  });

  elements.confirmCancelBtn.addEventListener('click', () => {
    elements.confirmDialog.close();
    confirmCallback = null;
  });

  // --- Mobile Drawer ---
  function openMobileSidebar() {
    elements.chatSidebar.classList.add('open');
    elements.sidebarOverlay.classList.add('active');
  }

  function closeMobileSidebar() {
    elements.chatSidebar.classList.remove('open');
    elements.sidebarOverlay.classList.remove('active');
  }

  // --- Event Listeners ---
  function initEventListeners() {
    // Mobile sidebar toggle
    elements.openSidebarBtn.addEventListener('click', openMobileSidebar);
    elements.closeSidebarBtn.addEventListener('click', closeMobileSidebar);
    elements.sidebarOverlay.addEventListener('click', closeMobileSidebar);

    // New Chat
    elements.newChatBtn.addEventListener('click', () => createNewSession());

    // Search input
    elements.searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      renderSessionsList();
    });

    // Form submit
    elements.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage(elements.messageInput.value);
    });

    // Stop button
    elements.stopBtn.addEventListener('click', () => {
      if (state.abortController) {
        state.abortController.abort();
      }
    });

    // Textarea auto-resize and Enter key behavior
    elements.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(elements.messageInput.value);
      }
    });

    elements.messageInput.addEventListener('input', () => {
      elements.messageInput.style.height = 'auto';
      elements.messageInput.style.height = Math.min(elements.messageInput.scrollHeight, 180) + 'px';
    });

    // Suggestion cards
    document.querySelectorAll('.suggestion-card').forEach(card => {
      card.addEventListener('click', () => {
        const prompt = card.dataset.prompt;
        if (prompt) {
          sendMessage(prompt);
        }
      });
    });

    // Inline rename title
    elements.renameChatBtn.addEventListener('click', () => {
      if (state.activeSessionId) {
        const s = state.sessions.find(x => x.id === state.activeSessionId);
        openRenameModal(state.activeSessionId, s ? s.title : elements.activeChatTitle.textContent);
      }
    });

    elements.activeChatTitle.addEventListener('click', () => {
      if (state.activeSessionId) {
        const s = state.sessions.find(x => x.id === state.activeSessionId);
        openRenameModal(state.activeSessionId, s ? s.title : elements.activeChatTitle.textContent);
      }
    });

    // Chat actions dropdown
    elements.chatActionsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.chatActionsMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      elements.chatActionsMenu.classList.add('hidden');
    });

    // Export options
    elements.actionExportMd.addEventListener('click', () => {
      if (!state.activeSessionId) return;
      window.location.href = `/api/export/${state.activeSessionId}?format=markdown`;
    });

    elements.actionExportJson.addEventListener('click', () => {
      if (!state.activeSessionId) return;
      window.location.href = `/api/export/${state.activeSessionId}?format=json`;
    });

    // Clear chat
    elements.actionClearChat.addEventListener('click', () => {
      if (!state.activeSessionId) return;
      openConfirmModal(
        'Clear Messages',
        'Are you sure you want to clear all messages in this conversation? This cannot be undone in SQLite.',
        clearCurrentChat
      );
    });

    // Delete chat
    elements.actionDeleteChat.addEventListener('click', () => {
      if (!state.activeSessionId) return;
      const s = state.sessions.find(x => x.id === state.activeSessionId);
      const title = s ? s.title : 'this conversation';
      openConfirmModal(
        'Delete Conversation',
        `Are you sure you want to delete "${title}"?`,
        () => deleteSession(state.activeSessionId)
      );
    });
  }

  // --- Initialize App ---
  function init() {
    initTheme();
    initEventListeners();
    fetchSessions();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
