(async () => {
  try {
    const res = await fetch('http://localhost:3000/api/email-sync');
    const data = await res.json();
    console.log(data);
  } catch(e) {
    console.error(e);
  }
})();
