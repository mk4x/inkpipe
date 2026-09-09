// The polyfill MUST come first. @noble captures crypto.getRandomValues at
// module load, so anything importing it before this line gets the missing
// function and throws on the first key operation.
import './src/polyfill.ts';

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
