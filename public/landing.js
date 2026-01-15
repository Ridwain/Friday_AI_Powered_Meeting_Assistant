document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('auth-modal');
    const navLoginBtn = document.getElementById('nav-login-btn');
    const heroSignupBtn = document.getElementById('hero-signup-btn');
    const closeModalBtn = document.getElementById('close-modal-btn');

    const loginTab = document.getElementById('show-login');
    const signupTab = document.getElementById('show-signup');

    // Open Modal Helpers
    function openModal(mode = 'login') {
        modal.classList.add('active');
        if (mode === 'signup') {
            signupTab.click(); // Trigger firebase.js logic + visual update
        } else {
            loginTab.click(); // Trigger firebase.js logic + visual update
        }
    }

    function closeModal() {
        modal.classList.remove('active');
    }

    // Event Listeners for Opening Modal
    navLoginBtn.addEventListener('click', () => openModal('login'));
    heroSignupBtn.addEventListener('click', () => openModal('signup'));

    // Close Modal
    closeModalBtn.addEventListener('click', closeModal);

    // Close on click outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Tab Switching Visuals
    // detailed logic is in firebase.js (showing/hiding forms),
    // here we just handle the 'active' class on tabs
    loginTab.addEventListener('click', () => {
        loginTab.classList.add('active');
        signupTab.classList.remove('active');
        // Update header text
        document.querySelector('.auth-header h2').textContent = 'Welcome Back';
        document.querySelector('.auth-header p').textContent = 'Sign in to continue to your dashboard';
    });

    signupTab.addEventListener('click', () => {
        signupTab.classList.add('active');
        loginTab.classList.remove('active');
        // Update header text
        document.querySelector('.auth-header h2').textContent = 'Get Started';
        document.querySelector('.auth-header p').textContent = 'Create your free account today';
    });

});
