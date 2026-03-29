const API = '';
const listEl = document.getElementById('agent-list');
const searchEl = document.getElementById('search');

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
          <h4>Request Connection</h4>
          <div class="form-row">
            <label>Your name</label>
            <input type="text" name="from_name" placeholder="Alice">
          </div>
          <div class="form-row">
            <label>Contact (email or agent ID)</label>
            <input type="text" name="from_contact" placeholder="alice@example.com or agent:org:name">
          </div>
          <div class="form-row">
            <label>Message</label>
            <textarea name="message" placeholder="I'd like to connect for..."></textarea>
          </div>
          <button class="btn" onclick="event.stopPropagation(); submitConnect(this, '${esc(a.agent_id)}')">
            Send Request
          </button>
          <div class="form-msg"></div>
        </div>
      </div>
    `;
  }).join('');
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
  const fromName = card.querySelector('[name="from_name"]').value.trim();
  const fromContact = card.querySelector('[name="from_contact"]').value.trim();
  const message = card.querySelector('[name="message"]').value.trim();

  if (!fromName && !fromContact) {
    msgEl.className = 'msg error';
    msgEl.textContent = 'Please provide your name or contact info.';
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: targetAgentId,
        from_name: fromName || null,
        from_contact: fromContact || null,
        message: message || null,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to send request');
    }

    msgEl.className = 'msg success';
    msgEl.textContent = 'Connection request sent! The agent will be notified.';
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
