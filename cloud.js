// Online mode: loads/saves the fund data in Firebase Firestore so members see the same numbers.
// The fund is private: only the admin (hashed in firebase-config.js) and the viewer emails the admin
// adds in Settings can read it. Firestore rules (in the Firebase console) enforce this.
import { firebaseConfig, adminEmailHashes, fundDocPath, viewersDocPath } from './firebase-config.js';

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
    const fundRef = fs.doc(db, fundDocPath);
    const viewersRef = fs.doc(db, viewersDocPath);
    let unsubscribe = [];

    window.cloudSave = state => fs.setDoc(fundRef, {
      data: JSON.stringify(state),
      updatedAt: fs.serverTimestamp(),
      updatedBy: auth.currentUser?.email || '',
    });
    window.cloudSetViewers = emails => fs.setDoc(viewersRef, { emails, updatedAt: fs.serverTimestamp() });
    window.cloudSignIn = () => au.signInWithPopup(auth, new au.GoogleAuthProvider().setCustomParameters({ prompt: 'select_account' }));
    window.cloudSignOut = () => au.signOut(auth);

    au.onAuthStateChanged(auth, async user => {
      unsubscribe.forEach(fn => fn());
      unsubscribe = [];
      app.applyRemote(null);
      if (!user) {
        app.setCloud({ user: null, canEdit: false, needSignIn: true, denied: false, ready: true, viewers: [] });
        return;
      }
      const isAdmin = !!user.email && adminEmailHashes.includes(await sha256(user.email.toLowerCase()));
      app.setCloud({ user: { email: user.email }, canEdit: isAdmin, needSignIn: false, denied: false, ready: false, error: '' });

      unsubscribe.push(fs.onSnapshot(fundRef, snap => {
        if (snap.metadata.hasPendingWrites) return; // our own write echoing back
        app.applyRemote(snap.exists() ? JSON.parse(snap.data().data) : null);
        app.setCloud({ ready: true, error: '' });
      }, err => {
        if (err.code === 'permission-denied') app.setCloud({ ready: true, denied: true });
        else app.setCloud({ ready: true, error: err.message });
      }));

      if (isAdmin) {
        unsubscribe.push(fs.onSnapshot(viewersRef,
          snap => app.setCloud({ viewers: snap.exists() ? snap.data().emails || [] : [] }),
          err => console.error('viewers', err)));
      }
    });
  } catch (err) {
    console.error(err);
    app.setCloud({ ready: true, error: err.message });
  }
}
