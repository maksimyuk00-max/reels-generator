import VideoGenerator from './VideoGenerator'

// Окрема сторінка редактора — рендерить VideoGenerator у режимі "тільки compose".
// Усі pre-compose steps (config/prompt/image/video) приховані.
// 2 кнопки збереження: "Оновити (ту саму)" + "Зберегти як нову" — коли прийшли з Історії.
export default function Editor() {
  return <VideoGenerator editorMode />
}
