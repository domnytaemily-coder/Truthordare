// Game settings. Claude fills in the Firebase part for you.
window.TOD_CONFIG = {
  // Firebase config. While apiKey is "DEMO" the game runs in demo mode:
  // it only syncs between tabs of the same browser (good for testing).
  firebase: {
    apiKey: "AIzaSyAhqrjjytvbVCA2DQ05OuLk_wT-lWI40Hw",
    authDomain: "truth-or-dare-ad6cd.firebaseapp.com",
    databaseURL: "https://truth-or-dare-ad6cd-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "truth-or-dare-ad6cd",
    storageBucket: "truth-or-dare-ad6cd.firebasestorage.app",
    messagingSenderId: "235490769171",
    appId: "1:235490769171:web:bfb85fd1771595b53a02e6"
  },
  // Name of the game room in the database.
  game: "party",
  // Secret part of the host link: your-site.netlify.app/#host-g53w5mkw
  hostCode: "g53w5mkw",
  // Claude model used for suggestions and checks.
  model: "claude-haiku-5-5"
};
