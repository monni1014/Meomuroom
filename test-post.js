(async () => {
  const body = {
    source: 'manual',
    roomName: '머무룸1',
    customerName: '테스트',
    startTime: '2026-06-12T14:00:00',
    endTime: '2026-06-12T15:00:00',
    price: 10000,
    headCount: 2,
    paymentMethod: '현장카드',
    isPaid: true
  };

  const res = await fetch('http://localhost:3000/api/reservations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Response:', text);
})();
