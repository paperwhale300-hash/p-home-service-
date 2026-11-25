# P-Pick Firebase Web App (starter release)

This is a Firebase-connected web app source project. It uses Firebase Authentication phone OTP and Cloud Firestore.

## 1) Configure Firebase
1. Open https://console.firebase.google.com/ and create/open your project.
2. Add a Web app (</> icon) and copy its Firebase config.
3. Replace the placeholder values in `firebase-config.js` with your Web app config.
4. In Firebase Console > Authentication > Sign-in method, enable **Phone**.
5. In Authentication > Settings, allow SMS regions you intend to serve (for example India), and add your deployed website domain under Authorized domains.
6. In Firestore Database, create a database and publish the contents of `firestore.rules` in the Rules tab.
7. Deploy the folder to Firebase Hosting or another HTTPS host. Phone auth requires an authorized domain and reCAPTCHA; do not test SMS phone auth by opening the HTML as a `file://` URL.

## 2) Deploy with Firebase Hosting (optional)
Install Node.js and Firebase CLI, then from this folder run:

```bash
npm install -g firebase-tools
firebase login
firebase init hosting
# Choose your existing Firebase project; set public directory to this folder; configure as a single-page app: No
firebase deploy --only hosting
```

If using `firebase init` in this folder, do not overwrite the provided files. Add your Hosting domain to Authentication > Settings > Authorized domains.

## 3) Make the first admin
New users are always created as `customer`. Sign in once with the phone number you own. In Firestore Data, open `users/{your-auth-uid}` and change its `role` field from `customer` to `admin` manually. Never let users select their own admin role in the public UI. The Firestore rules prevent users from changing their own role.

## Features in this starter
- Firebase phone number OTP with reCAPTCHA
- User profile documents created on first sign-in
- Firestore booking creation and real-time booking list updates
- Customer cancellation of pending bookings
- Admin booking status updates
- Technician application submission and admin-readable applications
- State/district saved to the user profile

## Important limitations before public launch
This is a working Firebase-connected starter, not a complete commercial marketplace. Technician approval workflow is stored as an application but an admin must review it in Firestore; technician job assignment, technician-side job acceptance, push/audio notifications, payments, chat, photo uploads, Aadhaar/KYC verification, Cloud Functions, abuse controls, and production monitoring are not implemented. Do not collect Aadhaar numbers or identity documents until you have a secure, compliant verification design. For production, use server-side role management (custom claims or trusted Cloud Functions), App Check, budget alerts, SMS abuse controls, and review the security rules with real test accounts.

Firebase Web API config is intended to be present in client code; it is not a service-account private key. Never publish service-account JSON, private keys, or admin credentials.
