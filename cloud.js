// Online mode: loads/saves the fund data in Firebase Firestore so everyone with the link sees the same numbers.
// Anyone can view; only the admin Google accounts (hashed in firebase-config.js, enforced by Firestore rules) can edit.
import { firebaseConfig, adminEmailHashes, fundDocPath } from './firebase-config.js';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
const app = window.sfApp;
const configured = firebaseConfig?.apiKey && !firebaseConfig.apiKey.startsWith('PASTE');

if (configured) {
  app.setCloud({ enabled: true, ready: false });
  try {
    const [{ initializeApp }, fs, au] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-auth.js`),
    ]);
    const fb = initializeApp(firebaseConfig);
    const db = fs.getFirestore(fb);
    const auth = au.getAuth(fb);
    const ref = fs.doc(db, fundDocPath);
    let isAdmin = false;

    window.cloudSave = state => fs.setDoc(ref, {
      data: JSON.stringify(state),
      updatedAt: fs.serverTimestamp(),
      updatedBy: auth.currentUser?.email || '',
    });
    window.cloudSignIn = () => au.signInWithPopup(auth, new au.GoogleAuthProvider());
    window.cloudSignOut = () => au.signOut(auth);

    au.onAuthStateChanged(auth, async user => {
      isAdmin = !!user?.email && adminEmailHashes.includes(await sha256(user.email.toLowerCase()));
      app.setCloud({ user: user ? { email: user.email } : null, canEdit: isAdmin });
    });

    fs.onSnapshot(ref, snap => {
      if (snap.metadata.hasPendingWrites) return; // our own write echoing back
      if (snap.exists()) app.applyRemote(JSON.parse(snap.data().data));
      else if (!isAdmin) app.applyRemote(null);
      app.setCloud({ ready: true, error: '' });
    }, err => app.setCloud({ ready: true, error: err.message }));
  } catch (err) {
    console.error(err);
    app.setCloud({ ready: true, error: err.message });
  }
}
