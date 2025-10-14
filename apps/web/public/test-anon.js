// SIMPLE TEST - Does the script even run?
console.log('🎭 TEST SCRIPT LOADED!');
alert('🎭 Script is running!\n\nIf you see this, the script loaded successfully.');

// Change the page title as a test
document.title = '🎭 ANONYMIZED - ' + document.title;

// Add a big red banner
const banner = document.createElement('div');
banner.textContent = '🎭 ANONYMIZATION SCRIPT IS RUNNING';
banner.style.cssText = `
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  background: red;
  color: white;
  padding: 20px;
  text-align: center;
  font-size: 24px;
  font-weight: bold;
  z-index: 999999;
`;
document.body.appendChild(banner);

console.log('✅ If you see a RED BANNER at the top, the script is working!');
