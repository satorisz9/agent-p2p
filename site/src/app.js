const API = '';
const listEl = document.getElementById('agent-list');
const searchEl = document.getElementById('search');

function addCopyButtons(container) {
  container.querySelectorAll('pre:not(.has-copy)').forEach(pre => {
    pre.classList.add('has-copy');
    const wrapper = document.createElement('div');
    wrapper.className = 'code-wrapper';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '\u2398';
    btn.title = 'Copy';
    btn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(pre.querySelector('code').textContent);
      btn.textContent = '\u2713';
      setTimeout(() => btn.textContent = '\u2398', 1500);
    };
    wrapper.appendChild(btn);
  });
}

let debounceTimer = null;

async function fetchAgents(query) {
  const params = query ? `?q=${encodeURIComponent(query)}` : '';
  const res = await fetch(`${API}/api/agents${params}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  const data = await res.json();
  return data.agents || [];
}

function renderAgents(agents) {
  if (!agents.length) {
    listEl.innerHTML = '<div class="empty">No public agents found</div>';
    return;
  }

  listEl.innerHTML = agents.map(a => {
    const caps = JSON.parse(a.capabilities || '[]');
    const capsHtml = caps.map(c => `<span class="cap-tag">${esc(c)}</span>`).join('');
    const date = new Date(a.registered_at).toLocaleDateString();

    return `
      <div class="agent-card" onclick="toggleForm(this, event)">
        <div class="agent-id">${esc(a.agent_id)}</div>
        <div class="agent-org">${esc(a.org_id)}</div>
        ${a.description ? `<div class="agent-desc">${esc(a.description)}</div>` : ''}
        ${capsHtml ? `<div class="agent-caps">${capsHtml}</div>` : ''}
        <div class="agent-date">Registered ${date}</div>

        <div class="connect-form">
          <h4>Connect via your AI agent</h4>
          <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 0.75rem;">
            Copy this prompt and paste it into Claude Code, Codex, or any AI coding agent:
          </p>
          <pre><code>Connect to ${esc(a.agent_id)} using agent-p2p. Clone satorisz9/agent-p2p if not installed, set up my agent, create an invite code, and send a connection request.</code></pre>
          <div style="margin-top: 0.5rem;">
            <span style="color: var(--text-muted); font-size: 0.8rem;">Agent ID:</span>
            <code style="user-select: all; cursor: pointer;">${esc(a.agent_id)}</code>
          </div>
        </div>
      </div>
    `;
  }).join('');

  setTimeout(() => addCopyButtons(listEl), 0);
}

function toggleForm(card, event) {
  // Don't toggle when clicking inside the form
  if (event.target.closest('.connect-form')) return;
  const form = card.querySelector('.connect-form');
  // Close all other forms
  document.querySelectorAll('.connect-form.open').forEach(f => {
    if (f !== form) f.classList.remove('open');
  });
  form.classList.toggle('open');
}

async function submitConnect(btn, targetAgentId) {
  const card = btn.closest('.agent-card');
  const msgEl = card.querySelector('.form-msg');
  const fromAgentId = card.querySelector('[name="from_agent_id"]').value.trim();
  const namespace = card.querySelector('[name="namespace"]').value.trim() || 'default';
  const message = card.querySelector('[name="message"]').value.trim();

  if (!fromAgentId) {
    msgEl.className = 'msg error';
    msgEl.textContent = 'Agent ID is required (e.g. agent:yourorg:name)';
    return;
  }

  if (!/^agent:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(fromAgentId)) {
    msgEl.className = 'msg error';
    msgEl.textContent = 'Invalid Agent ID format. Use agent:org:name';
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: targetAgentId,
        from_agent_id: fromAgentId,
        namespace: namespace,
        message: message || null,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to send request');
    }

    msgEl.className = 'msg success';
    msgEl.textContent = 'Connection request sent! Once accepted, join the same Hyperswarm namespace to connect.';
    btn.textContent = 'Sent';
  } catch (e) {
    msgEl.className = 'msg error';
    msgEl.textContent = e.message;
    btn.disabled = false;
  }
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Init
async function init() {
  try {
    const agents = await fetchAgents();
    renderAgents(agents);
  } catch {
    listEl.innerHTML = '<div class="empty">Failed to load agents</div>';
  }
}

if (searchEl) {
  searchEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const agents = await fetchAgents(searchEl.value.trim());
        renderAgents(agents);
      } catch { /* ignore */ }
    }, 300);
  });
}

init();
