// Firebase settings for the online (shared) version.
// Paste the values from Firebase console → Project settings → General → Your apps → Web app → "SDK setup and configuration".
// These values are not secret; access is controlled by firestore.rules.
// While apiKey still starts with "PASTE", the app runs in local-only mode.
export const firebaseConfig = {
  apiKey: 'AIzaSyAKTlvzYexLWIMiKwd5PjZ6brR43nqi49Y',
  authDomain: 'sinking-fund-da8f0.firebaseapp.com',
  projectId: 'sinking-fund-da8f0',
  storageBucket: 'sinking-fund-da8f0.firebasestorage.app',
  messagingSenderId: '723867204689',
  appId: '1:723867204689:web:76b79a7c279fb825bacc70',
};

// Google accounts allowed to edit, stored as SHA-256 hashes of the lowercase email so the address isn't public.
// Get one with:  printf '%s' 'name@gmail.com' | sha256sum
// This only decides which buttons show; the real lock is the email list in the Firestore rules (Firebase console).
export const adminEmailHashes = ['014317ea5aaa4dc8afa39c0fade4f6825075554e0eaa51d7468391ed647197ec'];

// Firestore document that holds the fund data.
export const fundDocPath = 'funds/main';
