import { initializeApp } from './firebase/firebase-app.js';
import { getAuth } from './firebase/firebase-auth.js';
import { getFirestore, initializeFirestore } from './firebase/firebase-firestore.js';

const isLocalhost = window.location.hostname.includes("localhost") || window.location.hostname === "127.0.0.1";

const firebaseConfig = {
  apiKey: "AIzaSyCQkiNi5bsfoOUxj9HsxDupXR7SmUHGKPI",
  authDomain: isLocalhost
    ? "friday-e65f2.firebaseapp.com"
    : "friday-e65f2.web.app",
  projectId: "friday-e65f2",
  storageBucket: "friday-e65f2.appspot.com",
  messagingSenderId: "837567341884",
  appId: "1:837567341884:web:1c940bd2cfdce899252a39"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Use experimentalForceLongPolling to prevent transport errors in extension
const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
});

export { auth, db };