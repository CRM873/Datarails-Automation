// pages/index.js
export default function Home() {
  return (
    <div style={{ 
      padding: '50px', 
      fontFamily: 'Arial, sans-serif',
      textAlign: 'center',
      backgroundColor: '#f5f5f5',
      minHeight: '100vh'
    }}>
      <h1>Toast → Datarails Automation Backend</h1>
      <p>Your automation backend is running successfully!</p>
      <div style={{ 
        marginTop: '30px',
        padding: '20px',
        backgroundColor: 'white',
        borderRadius: '8px',
        maxWidth: '600px',
        margin: '30px auto'
      }}>
        <h3>Available API Endpoints:</h3>
        <ul style={{ textAlign: 'left' }}>
          <li><strong>/api/test-email</strong> - Test email configuration</li>
          <li><strong>/api/test-connection</strong> - Test Toast SFTP connection (coming soon)</li>
          <li><strong>/api/run-automation</strong> - Run full automation (coming soon)</li>
        </ul>
      </div>
      <p style={{ color: '#666', marginTop: '30px' }}>
        This is the backend server. Your frontend will connect to these APIs.
      </p>
    </div>
  );
}
