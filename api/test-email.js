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

  const { senderEmail, senderPassword, datarailsEmail } = req.body;
  
  try {
    // Validate required fields
    if (!senderEmail || !senderPassword || !datarailsEmail) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required email configuration' 
      });
    }

    // Use Resend API key
    const RESEND_API_KEY = 're_j8rbD7vu_3kt4DcX65Dj9bh2cpHfZ4JbE';
    
    // For testing, we need to send TO the verified email (cromero@grove-pt.com)
    // The error showed that's your verified email in Resend
    const testRecipient = 'cromero@grove-pt.com'; // Use your verified email for testing
    
    // Send email via Resend API
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Toast Automation <onboarding@resend.dev>', // Resend's verified sender
        to: [testRecipient], // Send to your verified email
        subject: 'Toast-Datarails Integration Test Email',
        html: `
          <p>Hello,</p>
          <p>This is a test email from the Toast-Datarails automation system.</p>
          <p>If you receive this email, the email configuration is working correctly.</p>
          <p>Test details:</p>
          <ul>
            <li>Original Sender: ${senderEmail}</li>
            <li>Intended Recipient: ${datarailsEmail}</li>
            <li>Test Recipient: ${testRecipient}</li>
            <li>Time: ${new Date().toLocaleString()}</li>
          </ul>
          <p><strong>Note:</strong> This is a test email. In production, this would be sent to: ${datarailsEmail}</p>
          <p>Best regards,<br>Automated System</p>
        `
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Resend API error: ${errorText}`);
    }

    const result = await response.json();
    
    res.status(200).json({ 
      success: true, 
      message: 'Test email sent successfully via Resend',
      details: {
        from: senderEmail,
        to: testRecipient,
        intendedRecipient: datarailsEmail,
        messageId: result.id,
        note: 'Email sent to your verified address for testing'
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
