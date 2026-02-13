import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyC8pV49umhSq8aRWPf2b-EIB1QnRIVBibA",
  authDomain: "darts-17dd4.firebaseapp.com",
  databaseURL: "https://darts-17dd4-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "darts-17dd4",
  storageBucket: "darts-17dd4.firebasestorage.app",
  messagingSenderId: "253908414432",
  appId: "1:253908414432:web:6133ed6b44ce4b86e1c585",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);