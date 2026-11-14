const search=document.querySelector('#search');
const category=document.querySelector('#category');
const entries=[...document.querySelectorAll('.instruction')];
function filter(){
 const q=search.value.trim().toLowerCase();let shown=0;
 for(const entry of entries){
  const match=(!q||entry.textContent.toLowerCase().includes(q))&&(category.value==='all'||entry.dataset.category===category.value);
  entry.hidden=!match;if(match)shown++;
 }
 document.querySelector('#results').textContent=`${shown} of 44 mnemonics${shown===0?' · No matches. Try another operand or clear the filters.':''}`;
}
search.addEventListener('input',filter);category.addEventListener('change',filter);
// Deep opcode links must reveal their target even when a search is active.
function reveal(){const entry=document.getElementById(location.hash.slice(1));if(entry?.classList.contains('instruction')){search.value='';category.value='all';filter();entry.scrollIntoView();}}
window.addEventListener('hashchange',reveal);reveal();
