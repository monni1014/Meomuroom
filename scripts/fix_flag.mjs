async function fix() {
  const res = await fetch('http://localhost:3000/api/reservations');
  const data = await res.json();
  const target = data.find(d => d.customerName === '한국경제TV');
  if (target) {
    console.log('Found:', target.id);
    const patchRes = await fetch(`http://localhost:3000/api/reservations/${target.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isCleanUpBad: true })
    });
    console.log('PATCH result:', patchRes.status);
  } else {
    console.log('Not found');
  }
}
fix();
