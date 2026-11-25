import { authenticateRequest, createExportToken } from '../lib/auth.js';

export default function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

    const auth = authenticateRequest(req);
    if (!auth.authenticated || auth.role === 'none') {
        return res.status(200).json({ role: 'none', class: null });
    }

    const response = {
        role: auth.role,
        class: auth.teacherClass
    };

    if (auth.role === 'admin' || auth.role === 'deputy') {
        response.export_token = createExportToken(auth.userId);
    }

    return res.status(200).json(response);
}
