// Firebase settings for the online (shared) version.
// Paste the values from Firebase console → Project settings → General → Your apps → Web app → "SDK setup and configuration".
// These values are not secret; access is controlled by firestore.rules.
// While apiKey still starts with "PASTE", the app runs in local-only mode.
export const firebaseConfig = {
  apiKey: 'PASTE_YOUR_API_KEY',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  appId: 'PASTE_YOUR_APP_ID',
};

// Google accounts allowed to edit. Must match the list in firestore.rules.
export const adminEmails = ['your.email@gmail.com'];

// Firestore document that holds the fund data.
export const fundDocPath = 'funds/main';
