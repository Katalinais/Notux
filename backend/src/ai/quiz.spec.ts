import { buildUserPrompt, checkQuiz } from './quiz';

const q = (over: Record<string, unknown> = {}) => ({
  question: '¿Qué hace un INNER JOIN?',
  options: ['Solo coincidencias', 'Todo de la izquierda', 'Todo de ambos lados', 'Nada'],
  correctIndex: 0,
  explanation: 'Devuelve solo las filas que coinciden.',
  sourceNote: 'Tipos de JOIN',
  ...over,
});

describe('checkQuiz', () => {
  it('keeps good questions and drops malformed ones', () => {
    const quiz = checkQuiz(
      {
        title: '  ',
        questions: [
          q(),
          q({ options: ['a', 'b', 'c'] }),
          q({ correctIndex: 4 }),
          q({ correctIndex: 1.5 }),
          q({ question: ' ' }),
          q({ options: ['a', 'A', 'b', 'c'] }),
        ],
      },
      10,
    );
    expect(quiz.title).toBe('Quiz de repaso');
    expect(quiz.questions).toHaveLength(1);
  });

  it('never returns more questions than asked for', () => {
    expect(checkQuiz({ title: 'T', questions: [q(), q(), q()] }, 2).questions).toHaveLength(2);
  });
});

describe('buildUserPrompt', () => {
  it('wraps every note and states the count', () => {
    const prompt = buildUserPrompt(
      [
        { title: 'A', text: 'uno' },
        { title: 'B', text: 'dos' },
      ],
      5,
    );
    expect(prompt).toContain('<nota indice="2">');
    expect(prompt).toContain('<titulo>B</titulo>');
    expect(prompt).toContain('quiz de 5 preguntas');
  });
});
