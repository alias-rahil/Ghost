import React, {useCallback, useContext, useEffect, useId, useState} from 'react';

interface GlobalDirtyState {
    setGlobalDirtyState: (id: string, dirty: boolean) => void;
}

const GlobalDirtyStateContext = React.createContext<GlobalDirtyState>({setGlobalDirtyState: () => {}});

export const GlobalDirtyStateProvider = ({setDirty, children}: {setDirty?: (dirty: boolean) => void; children: React.ReactNode}) => {
    // Allows each component to register itself as dirty with a unique ID, so when one is reset/saved the overall page dirty state persists
    const [dirtyIds, setDirtyIds] = useState<string[]>([]);

    const setGlobalDirtyState = useCallback((id: string, dirty: boolean) => {
        setDirtyIds((current) => {
            if (dirty && !current.includes(id)) {
                return [...current, id];
            }

            if (!dirty && current.includes(id)) {
                return current.filter(currentId => currentId !== id);
            }

            return current;
        });
    }, []);

    useEffect(() => {
        setDirty?.(dirtyIds.length > 0);
    }, [dirtyIds, setDirty]);

    return (
        <GlobalDirtyStateContext.Provider value={{setGlobalDirtyState}}>
            {children}
        </GlobalDirtyStateContext.Provider>
    );
};

const useGlobalDirtyState = () => {
    const id = useId();
    const {setGlobalDirtyState} = useContext(GlobalDirtyStateContext);

    useEffect(() => {
        // Make sure the state is reset when the component unmounts
        return () => setGlobalDirtyState(id, false);
    }, [id, setGlobalDirtyState]);

    const setDirty = useCallback(
        (dirty: boolean) => setGlobalDirtyState(id, dirty),
        [id, setGlobalDirtyState]
    );

    return {
        setGlobalDirtyState: setDirty
    };
};

export default useGlobalDirtyState;
