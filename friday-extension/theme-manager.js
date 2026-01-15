/**
 * Theme Manager for Friday Extension
 * Handles theme switching and persistence with cross-page sync
 */

(function () {
    const THEME_STORAGE_KEY = 'friday_theme_preference';

    /**
     * Set the theme on the document
     * @param {string} theme - 'light' or 'dark'
     */
    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        updateToggleState(theme);
    }

    /**
     * Update the toggle switch visual state
     * @param {string} theme - 'light' or 'dark'
     */
    function updateToggleState(theme) {
        const toggle = document.getElementById('themeToggle');
        if (toggle) {
            toggle.checked = theme === 'dark';
        }
    }

    /**
     * Toggle between light and dark themes
     */
    function toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        setTheme(newTheme);

        // Save to chrome.storage
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ [THEME_STORAGE_KEY]: newTheme }, () => {
                console.log('Theme saved:', newTheme);
            });
        }
    }

    /**
     * Initialize theme based on stored preference
     * Default is 'light' mode
     */
    function loadAndApplyTheme() {
        // Check if chrome.storage is available
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get([THEME_STORAGE_KEY], (result) => {
                const savedTheme = result[THEME_STORAGE_KEY] || 'light';
                setTheme(savedTheme);
            });
        } else {
            // Fallback to light theme if chrome.storage is not available
            setTheme('light');
        }
    }

    function initUI() {
        loadAndApplyTheme(); // Ensure theme is correct when UI loads
        setupToggleListener();
        setupStorageListener();
    }

    /**
     * Setup event listener for the toggle switch
     */
    function setupToggleListener() {
        const toggle = document.getElementById('themeToggle');
        if (toggle) {
            // Remove any existing listeners to avoid duplicates
            toggle.removeEventListener('change', toggleTheme);
            toggle.addEventListener('change', toggleTheme);

            // Sync toggle state with current theme
            const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
            toggle.checked = currentTheme === 'dark';
        }
    }

    /**
     * Listen for storage changes from other pages/windows
     * This enables real-time theme sync across all open extension pages
     */
    function setupStorageListener() {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener((changes, areaName) => {
                if (areaName === 'local' && changes[THEME_STORAGE_KEY]) {
                    const newTheme = changes[THEME_STORAGE_KEY].newValue;
                    if (newTheme) {
                        console.log('Theme changed from another page:', newTheme);
                        setTheme(newTheme);
                    }
                }
            });
        }
    }

    // Attempt to apply theme immediately (even before DOMContentLoaded)
    loadAndApplyTheme();

    // Initialize UI when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else {
        // DOM is already ready
        initUI();
    }

    // Export for global access if needed
    window.FridayTheme = {
        init: initUI,
        toggle: toggleTheme,
        set: setTheme
    };
})();
