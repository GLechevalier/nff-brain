// The devtools_page: one call, nothing else. Panel registration is trivial —
// the panel document (panel.html/panel.ts) is where the feature lives.

chrome.devtools.panels.create('Brain', 'icons/32.png', 'panel.html');
