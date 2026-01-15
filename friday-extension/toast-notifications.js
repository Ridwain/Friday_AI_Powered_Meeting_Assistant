// toast-notifications.js
// Toast notification system for better error messaging and user feedback

/**
 * ToastManager - Manages toast notifications with various styles
 */
class ToastManager {
  constructor(options = {}) {
    this.containerId = options.containerId || 'friday-toast-container';
    this.position = options.position || 'bottom-right'; // top-left, top-right, bottom-left, bottom-right
    this.maxToasts = options.maxToasts || 5;
    this.defaultDuration = options.defaultDuration || 5000;
    this.container = null;
    this.shadowRoot = null;
    this.toasts = [];
    this.toastId = 0;

    this.init();
  }

  /**
   * Initialize toast container with Shadow DOM
   */
  init() {
    // Remove existing container
    const existing = document.getElementById(this.containerId);
    if (existing) existing.remove();

    // Create container
    this.container = document.createElement('div');
    this.container.id = this.containerId;

    // Position styles
    const positionStyles = this.getPositionStyles();
    this.container.style.cssText = `
      position: fixed;
      ${positionStyles}
      z-index: 1000000;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 400px;
      padding: 16px;
    `;

    // Attach Shadow DOM
    this.shadowRoot = this.container.attachShadow({ mode: 'open' });

    // Inject styles
    const styles = document.createElement('style');
    styles.textContent = this.getStyles();
    this.shadowRoot.appendChild(styles);

    document.body.appendChild(this.container);
    console.log('[ToastManager] Initialized');
  }

  /**
   * Get position styles based on position setting
   */
  getPositionStyles() {
    const positions = {
      'top-left': 'top: 0; left: 0;',
      'top-right': 'top: 0; right: 0;',
      'top-center': 'top: 0; left: 50%; transform: translateX(-50%);',
      'bottom-left': 'bottom: 0; left: 0;',
      'bottom-right': 'bottom: 0; right: 0;',
      'bottom-center': 'bottom: 0; left: 50%; transform: translateX(-50%);',
    };
    return positions[this.position] || positions['bottom-right'];
  }

  /**
   * Get CSS styles for toasts
   */
  getStyles() {
    return `
      * {
        box-sizing: border-box;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      .toast {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 14px 18px;
        border-radius: 14px;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.05);
        pointer-events: auto;
        min-width: 300px;
        max-width: 100%;
        animation: slideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        position: relative;
        overflow: hidden;
      }

      .toast.exiting {
        animation: slideOut 0.3s cubic-bezier(0.65, 0, 0.35, 1) forwards;
      }

      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateX(120px) scale(0.9);
        }
        to {
          opacity: 1;
          transform: translateX(0) scale(1);
        }
      }

      @keyframes slideOut {
        from {
          opacity: 1;
          transform: translateX(0) scale(1);
        }
        to {
          opacity: 0;
          transform: translateX(100px) scale(0.95);
        }
      }

      /* Toast types */
      .toast.success {
        background: linear-gradient(135deg, rgba(16, 185, 129, 0.95) 0%, rgba(5, 150, 105, 0.98) 100%);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.15);
      }

      .toast.error {
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.95) 0%, rgba(220, 38, 38, 0.98) 100%);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.15);
      }

      .toast.warning {
        background: linear-gradient(135deg, rgba(245, 158, 11, 0.95) 0%, rgba(217, 119, 6, 0.98) 100%);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.15);
      }

      .toast.info {
        background: linear-gradient(135deg, rgba(59, 130, 246, 0.95) 0%, rgba(37, 99, 235, 0.98) 100%);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.15);
      }

      .toast.loading {
        background: linear-gradient(135deg, rgba(26, 26, 36, 0.98) 0%, rgba(15, 15, 20, 0.99) 100%);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }

      /* Friday brand variant */
      .toast.friday {
        background: linear-gradient(135deg, rgba(124, 58, 237, 0.95) 0%, rgba(59, 130, 246, 0.95) 50%, rgba(6, 182, 212, 0.95) 100%);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.2);
        box-shadow: 0 8px 32px rgba(124, 58, 237, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.05);
      }

      /* Icon */
      .toast-icon {
        font-size: 20px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
      }

      .toast-icon.spin {
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      /* Content */
      .toast-content {
        flex: 1;
        min-width: 0;
      }

      .toast-title {
        font-weight: 600;
        font-size: 14px;
        margin-bottom: 2px;
      }

      .toast-message {
        font-size: 13px;
        opacity: 0.9;
        line-height: 1.4;
        word-wrap: break-word;
      }

      /* Close button */
      .toast-close {
        flex-shrink: 0;
        width: 24px;
        height: 24px;
        border: none;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: inherit;
        font-size: 14px;
        transition: all 0.15s ease;
        margin-left: 8px;
      }

      .toast-close:hover {
        background: rgba(255, 255, 255, 0.3);
        transform: scale(1.1);
      }

      /* Progress bar */
      .toast-progress {
        position: absolute;
        bottom: 0;
        left: 0;
        height: 3px;
        background: rgba(255, 255, 255, 0.4);
        border-radius: 0 0 10px 10px;
        animation: progress linear forwards;
      }

      @keyframes progress {
        from { width: 100%; }
        to { width: 0%; }
      }

      /* Action buttons */
      .toast-actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }

      .toast-action {
        padding: 6px 12px;
        border: 1px solid rgba(255, 255, 255, 0.3);
        background: rgba(255, 255, 255, 0.1);
        color: inherit;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .toast-action:hover {
        background: rgba(255, 255, 255, 0.2);
      }

      .toast-action.primary {
        background: rgba(255, 255, 255, 0.25);
        border-color: rgba(255, 255, 255, 0.4);
      }
    `;
  }

  /**
   * Get icon for toast type
   */
  getIcon(type) {
    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ',
      loading: '◌',
    };
    return icons[type] || icons.info;
  }

  /**
   * Show a toast notification
   * @param {Object} options - Toast configuration
   * @returns {number} - Toast ID
   */
  show(options = {}) {
    const {
      type = 'info',
      title = '',
      message = '',
      duration = this.defaultDuration,
      closable = true,
      actions = [], // Array of { label, onClick, primary }
      icon = null,
      onClose = null,
    } = options;

    // Remove oldest toast if at max
    if (this.toasts.length >= this.maxToasts) {
      this.dismiss(this.toasts[0].id);
    }

    const id = ++this.toastId;
    const toastIcon = icon || this.getIcon(type);

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.dataset.id = id;

    // Build actions HTML
    let actionsHtml = '';
    if (actions.length > 0) {
      actionsHtml = `
        <div class="toast-actions">
          ${actions.map((action, i) => `
            <button class="toast-action ${action.primary ? 'primary' : ''}" data-action="${i}">
              ${action.label}
            </button>
          `).join('')}
        </div>
      `;
    }

    toast.innerHTML = `
      <span class="toast-icon ${type === 'loading' ? 'spin' : ''}">${toastIcon}</span>
      <div class="toast-content">
        ${title ? `<div class="toast-title">${title}</div>` : ''}
        <div class="toast-message">${message}</div>
        ${actionsHtml}
      </div>
      ${closable ? '<button class="toast-close" title="Dismiss">×</button>' : ''}
      ${duration > 0 ? `<div class="toast-progress" style="animation-duration: ${duration}ms;"></div>` : ''}
    `;

    // Event handlers
    if (closable) {
      toast.querySelector('.toast-close').addEventListener('click', () => {
        this.dismiss(id);
        if (onClose) onClose();
      });
    }

    // Action button handlers
    actions.forEach((action, index) => {
      const btn = toast.querySelector(`[data-action="${index}"]`);
      if (btn && action.onClick) {
        btn.addEventListener('click', () => {
          action.onClick();
          if (action.dismiss !== false) {
            this.dismiss(id);
          }
        });
      }
    });

    // Add to DOM
    this.shadowRoot.appendChild(toast);

    // Store reference
    const toastData = {
      id,
      element: toast,
      timeout: duration > 0 ? setTimeout(() => this.dismiss(id), duration) : null,
      onClose,
    };
    this.toasts.push(toastData);

    console.log(`[ToastManager] Showed toast ${id}: ${type}`);
    return id;
  }

  /**
   * Dismiss a toast
   */
  dismiss(id) {
    const index = this.toasts.findIndex(t => t.id === id);
    if (index === -1) return false;

    const toast = this.toasts[index];

    // Clear timeout
    if (toast.timeout) {
      clearTimeout(toast.timeout);
    }

    // Animate out
    toast.element.classList.add('exiting');

    setTimeout(() => {
      toast.element.remove();
      this.toasts.splice(index, 1);
      if (toast.onClose) toast.onClose();
    }, 300);

    return true;
  }

  /**
   * Dismiss all toasts
   */
  dismissAll() {
    [...this.toasts].forEach(toast => this.dismiss(toast.id));
  }

  /**
   * Update a toast (useful for loading state changes)
   */
  update(id, options = {}) {
    const toast = this.toasts.find(t => t.id === id);
    if (!toast) return false;

    const { type, title, message, icon } = options;

    if (type) {
      toast.element.className = `toast ${type}`;
    }
    if (title !== undefined) {
      const titleEl = toast.element.querySelector('.toast-title');
      if (titleEl) titleEl.textContent = title;
    }
    if (message !== undefined) {
      toast.element.querySelector('.toast-message').textContent = message;
    }
    if (icon !== undefined) {
      const iconEl = toast.element.querySelector('.toast-icon');
      iconEl.textContent = icon || this.getIcon(type || 'info');
      iconEl.classList.toggle('spin', type === 'loading');
    }

    return true;
  }

  // Convenience methods
  success(message, title = '', options = {}) {
    return this.show({ type: 'success', message, title, ...options });
  }

  error(message, title = 'Error', options = {}) {
    return this.show({ type: 'error', message, title, duration: 8000, ...options });
  }

  warning(message, title = 'Warning', options = {}) {
    return this.show({ type: 'warning', message, title, ...options });
  }

  info(message, title = '', options = {}) {
    return this.show({ type: 'info', message, title, ...options });
  }

  loading(message, title = '', options = {}) {
    return this.show({ type: 'loading', message, title, duration: 0, closable: false, ...options });
  }

  /**
   * Destroy the toast manager
   */
  destroy() {
    this.dismissAll();
    if (this.container) {
      this.container.remove();
    }
    console.log('[ToastManager] Destroyed');
  }
}

// Export for use in extension
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ToastManager };
}

// Make available globally
if (typeof window !== 'undefined') {
  window.ToastManager = ToastManager;
}
