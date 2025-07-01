// api/test-email.js
export default async function handler(req, res) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { senderEmail, datarailsEmail } = req.body;
  
  try {
    // Validate required fields
    if (!senderEmail || !datarailsEmail) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required email configuration' 
      });
    }

    // Use Resend API key (temporarily hardcoded, we'll make this secure next)
    const RESEND_API_KEY = 're_j8rbD7vu_3kt4DcX65Dj9bh2cpHfZ4JbE';
    
    // Send email via Resend API
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Toast Automation <onboarding@resend.dev>', // Resend verified sender
        to: [datarailsEmail],
        subject: 'Toast-Datarails Integration Test Email',
        html: `
          <p>Hello,</p>
          <p>This is a test email from the Toast-Datarails automation system.</p>
          <p>If you receive this email, the email configuration is working correctly.</p>
          <p>Test details:</p>
          <ul>
            <li>Sender: ${senderEmail}</li>
            <li>Recipient: ${datarailsEmail}</li>
            <li>Time: ${new Date().toLocaleString()}</li>
          </ul>
          <p>Best regards,<br>Automated System</p>
        `
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend API error: ${error}`);
    }

    const result = await response.json();
    
    res.status(200).json({ 
      success: true, 
      message: 'Test email sent successfully via Resend',
      details: {
        from: senderEmail,
        to: datarailsEmail,
        messageId: result.id
      }
    });
    
  } catch (error) {
    console.error('Email test error:', error);
    res.status(500).json({ 
      success: false, 
      error: `Email test failed: ${error.message}`,
      details: {
        sender: senderEmail,
        recipient: datarailsEmail
      }
    });
  }
}
