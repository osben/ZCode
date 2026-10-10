/// <reference types="node" />

// ui primarily runs in a browser, but some modules (such as the logger’s production check) read process.env;
// explicitly include the Node types here so global declarations are not lost as dependencies change.
