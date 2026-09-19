const panel = document.querySelector('#demo-panel');
const tabs = [...document.querySelectorAll('[role="tab"]')];
const buildView = panel.innerHTML;
const views = {
  build: buildView,
  review: `<div class="review-content"><span class="demo-kicker">GIT, WITHOUT THE CONTEXT SWITCH</span><div class="review-header"><h3 class="demo-title">A second perspective on every change.</h3><span class="demo-badge">✓ Ready for your review</span></div><p class="demo-description">Keep the conversation next to the code. Inspect your diff, explore branches, and work across worktrees from one workspace.</p><div class="review-diff"><header><span>⑂ feature/command-menu &nbsp; / &nbsp; CommandMenu.tsx</span><span>+3 −1</span></header><pre>  export function CommandMenu() {
    return (
<span class="remove">−     &lt;div className="results"&gt;</span><span class="add">+     &lt;div role="listbox"</span><span class="add">+       aria-label="Commands"&gt;</span><span class="add">+       &lt;CommandResults /&gt;</span>      &lt;/div&gt;
    );
  }</pre></div><p class="demo-footer-note">Illustrative example. This preview does not access your files or run an agent.</p></div>`,
  models: `<div class="models-content"><span class="demo-kicker">ONE WORKSPACE. YOUR CHOICE OF MODEL.</span><h3 class="demo-title">Choose where the thinking happens.</h3><p class="demo-description">Use built-in chat with a cloud provider, connect your own endpoint, or download a GGUF model to run on your machine.</p><div class="model-options"><article class="model-option"><span>☁</span><h4>Cloud providers</h4><p>Connect Anthropic, OpenAI, or OpenRouter with your own account.</p></article><article class="model-option"><span>⌘</span><h4>Your endpoint</h4><p>Bring an OpenAI-compatible API and use it in the same chat workspace.</p></article><article class="model-option local"><span>▦</span><h4>Local GGUF</h4><p>Browse Hugging Face models and run them locally with llama-server.</p><div class="model-chip">On-device inference</div></article></div><p class="demo-footer-note">Illustrative preview. Local model performance depends on your hardware and chosen model.</p></div>`,
};

function selectTab(tab, moveFocus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  panel.innerHTML = views[tab.dataset.view];
  panel.setAttribute('aria-labelledby', tab.id);
  if (moveFocus) tab.focus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(tab);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectTab(tabs[next], true);
    }
  });
}
