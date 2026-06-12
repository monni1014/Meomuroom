(async () => {
  const res = await fetch('http://localhost:3000/api/reservations');
  const reservations = await res.json();
  const today = new Date().toISOString().split('T')[0]; // "2026-06-12"
  
  const createdToday = reservations.filter(r => r.createdAt && r.createdAt.startsWith(today));
  console.log('Created today:', createdToday.length);
  createdToday.forEach(r => console.log(`- ${r.customerName} : ${r.startTime}`));
})();
